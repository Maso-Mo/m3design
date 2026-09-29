/**
 * Tests d'intégration du traitement de la file des notifications.
 *
 * Ils s'exécutent contre une VRAIE base D1 locale (migrations appliquées) et un
 * fournisseur FACTICE injecté : aucun réseau, aucun courriel réel. Ce qui est
 * vérifié ici, c'est ce qui se passe entre les deux :
 *
 *   * une notification due est envoyée une fois, puis marquée acceptée — et un
 *     second passage ne la renvoie pas ;
 *   * un échec temporaire programme un nouvel essai, avec l'attente du projet ou
 *     celle annoncée par le fournisseur ;
 *   * au plafond de tentatives, l'entrée est abandonnée et le fournisseur n'est plus
 *     appelé pour elle ;
 *   * deux passages simultanés n'envoient pas deux fois le même courriel ;
 *   * une entrée laissée « en cours » par un traitement interrompu est reprise
 *     après l'expiration de son bail ;
 *   * ni le journal ni la colonne `last_error` ne recueillent une donnée personnelle
 *     ou un message de fournisseur.
 *
 * Le contenu du courriel (référence, numéro vérifié, description) est produit par
 * `services/notifications.ts` et vérifié dans les tests de route ; ici, la file est
 * remplie directement, ce qui isole le traitement de la composition du message.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  claimEmailOutboxEntry,
  enqueueQuoteNotification,
} from '../src/db/repositories/email-outbox'
import { createQuoteRequest } from '../src/db/repositories/quote-requests'
import type { EmailProvider } from '../src/providers/messaging'
import {
  RETRY_SCHEDULE_SECONDS,
  dispatchOneEmail,
  dispatchPendingEmails,
  readEmailDispatchPolicy,
  retryDelaySeconds,
} from '../src/services/email-dispatch'
import type { EmailDispatchPolicy } from '../src/services/email-dispatch'
import {
  clearOperationalTables,
  createTestDatabase,
  type TestDatabase,
} from './helpers/database'
import { createEmailLogSpy, createEmailProviderSpy } from './helpers/email'

/** Instant de référence : 2027-01-15T08:00:00Z. */
const NOW = 1_800_000_000
const RECIPIENT = 'notifications@m3design.test'
const SUBJECT = 'Nouvelle demande de devis DEV-2027-00000001'
const BODY = 'Portail coulissant en aluminium, largeur 4 m, hors pose.'

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.dispose()
})

beforeEach(async () => {
  // Chaque cas part d'une file vide : les compteurs du bilan et les listes de
  // candidates ne dépendent donc pas de l'ordre d'exécution.
  await clearOperationalTables(database.db)
})

let sequence = 0

/** Crée une demande de test et met sa notification en file. */
async function enqueue(
  now = NOW,
): Promise<{ quoteId: number; emailId: number }> {
  sequence += 1
  const reference = `DEV-2027-${String(sequence).padStart(8, '0')}`
  const quote = await createQuoteRequest(database.db, {
    reference,
    idempotencyKey: `idem-${reference}`,
    phoneNormalized: `+2613399${String(10_000 + sequence)}`,
    phoneRaw: `+2613399${String(10_000 + sequence)}`,
    description: BODY,
    contactName: 'Test local',
    contactEmail: 'test@example.test',
    now,
  })
  const queued = await enqueueQuoteNotification(database.db, {
    quoteRequestId: quote.quote.id,
    recipient: RECIPIENT,
    subject: SUBJECT,
    bodyText: BODY,
    now,
  })
  return { quoteId: quote.quote.id, emailId: queued.email?.id ?? 0 }
}

/** Ligne de la file telle qu'un exploitant la lirait. */
function readRow(emailId: number): Promise<{
  status: string
  attempts: number
  next_attempt_at: number
  last_error: string | null
  sent_at: number | null
} | null> {
  return database.db
    .prepare(
      `SELECT status, attempts, next_attempt_at, last_error, sent_at
         FROM email_outbox
        WHERE id = ?1`,
    )
    .bind(emailId)
    .first<{
      status: string
      attempts: number
      next_attempt_at: number
      last_error: string | null
      sent_at: number | null
    }>()
}

/** Politique de test explicite, pour ne pas dépendre des valeurs par défaut. */

describe('envoi des notifications dues', () => {
  it('envoie une notification due, la marque acceptée, et ne la renvoie pas', async () => {
    const { emailId } = await enqueue()
    const spy = createEmailProviderSpy({
      results: [{ accepted: true, providerMessageId: 'msg-1' }],
    })
    const { entries, log } = createEmailLogSpy()

    const summary = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy: POLICY,
      now: NOW,
      log,
    })

    expect(summary).toEqual({
      examined: 1,
      claimed: 1,
      sent: 1,
      retried: 0,
      abandoned: 0,
      lost: 0,
    })
    // Le courriel transmis est exactement celui de la file : rien de plus, rien de
    // moins. La composition du message n'est pas refaite ici.
    expect(spy.sent).toEqual([
      { to: RECIPIENT, subject: SUBJECT, bodyText: BODY },
    ])
    expect(await readRow(emailId)).toMatchObject({
      status: 'sent',
      attempts: 1,
      sent_at: NOW,
      last_error: null,
    })
    expect(entries).toEqual([
      {
        event: 'email.dispatch',
        outcome: 'sent',
        reason: 'sent',
        emailId,
        attempts: 1,
        providerMessageId: 'msg-1',
      },
    ])

    // Second passage immédiat : plus rien n'est dû, et le fournisseur n'est pas
    // rappelé. C'est l'anti-doublon de la file, vu de l'extérieur.
    const again = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy: POLICY,
      now: NOW + 1,
      log,
    })
    expect(again).toEqual({
      examined: 0,
      claimed: 0,
      sent: 0,
      retried: 0,
      abandoned: 0,
      lost: 0,
    })
    expect(spy.sent).toHaveLength(1)
  })

  it('programme un nouvel essai après un échec temporaire, puis réussit', async () => {
    const { emailId } = await enqueue()
    const spy = createEmailProviderSpy({
      results: [
        { accepted: false, errorCode: 'provider_unavailable' },
        { accepted: true, providerMessageId: 'msg-2' },
      ],
    })

    const first = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy: POLICY,
      now: NOW,
    })
    expect(first).toMatchObject({
      examined: 1,
      claimed: 1,
      sent: 0,
      retried: 1,
      abandoned: 0,
      lost: 0,
    })
    expect(await readRow(emailId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'provider_unavailable',
      next_attempt_at: NOW + (RETRY_SCHEDULE_SECONDS[0] ?? 60),
    })

    // L'échéance n'est pas atteinte : le passage ne touche à rien.
    const tooEarly = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy: POLICY,
      now: NOW + 59,
    })
    expect(tooEarly.examined).toBe(0)

    // À l'échéance : deuxième tentative, comptée comme telle.
    const second = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy: POLICY,
      now: NOW + 60,
    })
    expect(second).toMatchObject({ examined: 1, claimed: 1, sent: 1 })
    expect(await readRow(emailId)).toMatchObject({
      status: 'sent',
      attempts: 2,
      sent_at: NOW + 60,
      last_error: null,
    })
    expect(spy.sent).toHaveLength(2)
  })

  it('respecte le délai annoncé par le fournisseur plutôt que le sien', async () => {
    const { emailId } = await enqueue()
    const spy = createEmailProviderSpy({
      results: [
        { accepted: false, errorCode: 'rate_limited', retryAfterSeconds: 900 },
      ],
    })

    await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy: POLICY,
      now: NOW,
    })

    expect(await readRow(emailId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'rate_limited',
      next_attempt_at: NOW + 900,
    })
  })

  it('abandonne au plafond de tentatives et cesse d’appeler le fournisseur', async () => {
    const { emailId } = await enqueue()
    const spy = createEmailProviderSpy({
      results: [{ accepted: false, errorCode: 'timeout' }],
    })
    const policy: EmailDispatchPolicy = { maxAttempts: 2, batchSize: 10 }
    const { entries, log } = createEmailLogSpy()

    const first = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy,
      now: NOW,
      log,
    })
    expect(first).toMatchObject({ retried: 1 })

    const second = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy,
      now: NOW + 60,
      log,
    })
    expect(second).toMatchObject({ claimed: 1, retried: 0, abandoned: 1 })
    expect(await readRow(emailId)).toMatchObject({
      status: 'failed',
      attempts: 2,
      last_error: 'timeout',
      sent_at: null,
    })

    // Beaucoup plus tard : l'entrée abandonnée n'est plus proposée, et le
    // fournisseur n'est pas rappelé une troisième fois.
    const later = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy,
      now: NOW + 100_000,
      log,
    })
    expect(later.examined).toBe(0)
    expect(spy.sent).toHaveLength(2)

    // Le journal dit l'abandon, sans donnée personnelle.
    const reasons = entries.map((entry) => entry.reason)
    expect(reasons).toContain('abandoned')
  })
})

describe('concurrence et reprise', () => {
  it('n’envoie qu’une fois malgré deux passages simultanés', async () => {
    const { emailId } = await enqueue()
    // Le fournisseur prend un peu de temps : le second passage examine la file
    // pendant que le premier est encore en train d'envoyer.
    const spy = createEmailProviderSpy({
      results: [{ accepted: true, providerMessageId: 'msg-3' }],
      delayMs: 40,
    })

    const run = () =>
      dispatchPendingEmails({
        db: database.db,
        provider: spy.provider,
        policy: POLICY,
        now: NOW,
      })
    const [first, second] = await Promise.all([run(), run()])

    // Un seul courriel est parti, et un seul passage le revendique.
    expect(spy.sent).toHaveLength(1)
    expect(first.sent + second.sent).toBe(1)
    expect(await readRow(emailId)).toMatchObject({
      status: 'sent',
      attempts: 1,
    })
  })

  it('reprend une entrée laissée en cours après un arrêt brutal', async () => {
    const { emailId } = await enqueue()
    // Un traitement prend l'entrée puis disparaît sans rien marquer (bail court,
    // comme après une limite de temps du Worker).
    await claimEmailOutboxEntry(database.db, {
      emailId,
      leaseSeconds: 30,
      maxAttempts: 5,
      now: NOW,
    })
    const spy = createEmailProviderSpy({
      results: [{ accepted: true, providerMessageId: 'msg-4' }],
    })

    // Bail encore valide : surtout, ne pas envoyer une seconde fois.
    const duringLease = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy: POLICY,
      now: NOW + 29,
    })
    expect(duringLease.examined).toBe(0)
    expect(spy.sent).toHaveLength(0)

    // Bail expiré : l'entrée est reprise et le courriel part.
    const afterLease = await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy: POLICY,
      now: NOW + 30,
    })
    expect(afterLease).toMatchObject({ examined: 1, claimed: 1, sent: 1 })
    expect(await readRow(emailId)).toMatchObject({
      status: 'sent',
      attempts: 2,
    })
  })
})

describe('étanchéité du journal et des codes d’échec', () => {
  it('remplace un code d’échec fantaisiste et n’écrit aucune donnée personnelle', async () => {
    const { emailId } = await enqueue()
    // Un fournisseur (ou un double de test) qui renvoie un message complet au lieu
    // d'un code : rien de tout cela ne doit ressortir.
    const spy = createEmailProviderSpy({
      results: [
        {
          accepted: false,
          errorCode: `Error: refus pour ${RECIPIENT} — sujet « ${SUBJECT} »`,
        },
      ],
    })
    const { entries, log } = createEmailLogSpy()

    await dispatchPendingEmails({
      db: database.db,
      provider: spy.provider,
      policy: POLICY,
      now: NOW,
      log,
    })

    const row = await readRow(emailId)
    expect(row?.last_error).toBe('provider_error')
    expect(row?.last_error).not.toContain(RECIPIENT)

    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain(RECIPIENT)
    expect(serialized).not.toContain(SUBJECT)
    expect(serialized).not.toContain(BODY)
    expect(serialized).not.toContain('refus pour')
  })

  it('traite un fournisseur qui lève comme un échec, pas comme une panne', async () => {
    const { emailId } = await enqueue()
    const provider: EmailProvider = {
      send: () =>
        Promise.reject(new Error(`panne du service pour ${RECIPIENT}`)),
    }
    const { entries, log } = createEmailLogSpy()

    const summary = await dispatchPendingEmails({
      db: database.db,
      provider,
      policy: POLICY,
      now: NOW,
      log,
    })

    // L'échec est enregistré et programmé comme les autres : la file n'est pas
    // perdue parce qu'un fournisseur a levé au lieu de répondre.
    expect(summary).toMatchObject({ claimed: 1, retried: 1, sent: 0 })
    expect(await readRow(emailId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'provider_exception',
    })
    expect(JSON.stringify(entries)).not.toContain(RECIPIENT)
  })
})

describe('envoi ciblé d’une seule notification', () => {
  it('n’envoie que l’entrée désignée, et laisse les autres intactes', async () => {
    const first = await enqueue()
    const second = await enqueue()
    const spy = createEmailProviderSpy({
      results: [{ accepted: true, providerMessageId: 'msg-cible' }],
    })

    const outcome = await dispatchOneEmail({
      db: database.db,
      provider: spy.provider,
      emailId: first.emailId,
      now: NOW,
    })

    expect(outcome).toMatchObject({
      claimed: true,
      status: 'sent',
      emailId: first.emailId,
      attempts: 1,
    })
    expect(spy.sent).toHaveLength(1)
    // L'autre notification attend toujours, sans le moindre essai : un envoi ciblé
    // ne peut pas emporter les demandes qui patientaient dans la file.
    expect(await readRow(second.emailId)).toMatchObject({
      status: 'pending',
      attempts: 0,
      sent_at: null,
    })
  })

  it('refuse d’envoyer une entrée déjà acceptée ou inconnue', async () => {
    const { emailId } = await enqueue()
    const spy = createEmailProviderSpy({
      results: [{ accepted: true, providerMessageId: 'msg-une-fois' }],
    })

    expect(
      await dispatchOneEmail({
        db: database.db,
        provider: spy.provider,
        emailId,
        now: NOW,
      }),
    ).toMatchObject({ claimed: true, status: 'sent' })

    // Deuxième tentative sur la même entrée : rien n'est envoyé, et le refus est dit.
    const again = await dispatchOneEmail({
      db: database.db,
      provider: spy.provider,
      emailId,
      now: NOW + 10,
    })
    expect(again).toEqual({
      claimed: false,
      status: 'not_claimable',
      emailId,
    })

    // Entrée inexistante : même refus, aucune exception.
    expect(
      await dispatchOneEmail({
        db: database.db,
        provider: spy.provider,
        emailId: 999_999,
        now: NOW + 10,
      }),
    ).toEqual({ claimed: false, status: 'not_claimable', emailId: 999_999 })

    // Le fournisseur n'a été appelé qu'une seule fois, pour la première tentative.
    expect(spy.sent).toHaveLength(1)
  })

  it('rend une issue explicite en cas d’échec temporaire', async () => {
    const { emailId } = await enqueue()
    const spy = createEmailProviderSpy({
      results: [
        { accepted: false, errorCode: 'rate_limited', retryAfterSeconds: 120 },
      ],
    })

    const outcome = await dispatchOneEmail({
      db: database.db,
      provider: spy.provider,
      emailId,
      now: NOW,
    })

    // L'outil d'exploitation lit ici de quoi décider : l'essai a bien eu lieu, il a
    // échoué pour une raison connue, et un nouvel essai est programmé.
    expect(outcome).toEqual({
      claimed: true,
      status: 'retried',
      emailId,
      attempts: 1,
      errorCode: 'rate_limited',
    })
    expect(await readRow(emailId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      next_attempt_at: NOW + 120,
      last_error: 'rate_limited',
    })
  })
})

describe('politique d’envoi', () => {
  it('garde des valeurs par défaut prudentes, sans configuration', () => {
    expect(readEmailDispatchPolicy({})).toEqual({
      maxAttempts: 5,
      batchSize: 10,
    })
  })

  it('lit les réglages fournis et refuse ceux qui sortent des bornes', () => {
    expect(
      readEmailDispatchPolicy({
        EMAIL_MAX_ATTEMPTS: '3',
        EMAIL_DISPATCH_BATCH_SIZE: '25',
      }),
    ).toEqual({ maxAttempts: 3, batchSize: 25 })

    // Une valeur mal formée n'est pas corrigée en silence : le passage est annulé
    // plutôt que de laisser croire à une politique qui n'est pas appliquée.
    for (const value of ['0', '21', 'beaucoup', '-2']) {
      expect(() =>
        readEmailDispatchPolicy({ EMAIL_MAX_ATTEMPTS: value }),
      ).toThrow(/EMAIL_MAX_ATTEMPTS/)
    }
    for (const value of ['0', '51', 'plein']) {
      expect(() =>
        readEmailDispatchPolicy({ EMAIL_DISPATCH_BATCH_SIZE: value }),
      ).toThrow(/EMAIL_DISPATCH_BATCH_SIZE/)
    }
  })

  it('espace les nouvelles tentatives de plus en plus', () => {
    // La progression est croissante, et le dernier palier se répète au-delà.
    const first = retryDelaySeconds(1)
    const second = retryDelaySeconds(2)
    expect(second).toBeGreaterThan(first)
    expect(retryDelaySeconds(RETRY_SCHEDULE_SECONDS.length)).toBe(
      RETRY_SCHEDULE_SECONDS[RETRY_SCHEDULE_SECONDS.length - 1],
    )
    expect(retryDelaySeconds(50)).toBe(
      RETRY_SCHEDULE_SECONDS[RETRY_SCHEDULE_SECONDS.length - 1],
    )
  })
})

const POLICY: EmailDispatchPolicy = { maxAttempts: 5, batchSize: 10 }
