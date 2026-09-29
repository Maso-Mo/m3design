/**
 * Tests d'intégration de la file d'attente des courriels.
 *
 * Une notification de demande ne doit jamais être envoyée deux fois, ne doit jamais
 * être perdue parce que le fournisseur est indisponible, et les données personnelles
 * qu'elle contient (adresse du destinataire, texte du message) doivent disparaître
 * avec la purge. Ce sont ces garanties qui sont vérifiées ici, contre la vraie base.
 *
 * Les adresses sont fictives et les dates fixes : aucun envoi, aucun accès réseau.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimEmailOutboxEntry,
  enqueueQuoteNotification,
  findEmailOutboxByReference,
  listDueEmailOutbox,
  markEmailOutboxFailed,
  markEmailOutboxSent,
  purgeEmailOutbox,
} from '../src/db/repositories/email-outbox'
import { createQuoteRequest } from '../src/db/repositories/quote-requests'
import { createTestDatabase, type TestDatabase } from './helpers/database'

/** Instant de référence : 2027-01-15T08:00:00Z. */
const NOW = 1_800_000_000
const RECIPIENT = 'aina@example.test'
const SUBJECT = 'Votre demande de devis est enregistrée'
const BODY = 'Bonjour Aina, nous revenons vers vous sous 48 heures ouvrées.'

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.dispose()
})

let sequence = 0

/** Crée une demande de test et renvoie son identifiant interne. */
async function createQuote(now = NOW): Promise<number> {
  sequence += 1
  const reference = `DEV-2027-${String(sequence).padStart(8, '0')}`
  const outcome = await createQuoteRequest(database.db, {
    reference,
    idempotencyKey: `idem-${reference}`,
    phoneNormalized: `+2613399${String(10_000 + sequence)}`,
    phoneRaw: `+2613399${String(10_000 + sequence)}`,
    description: 'Portail coulissant en aluminium, largeur 4 m, hors pose.',
    contactName: 'Test local',
    contactEmail: 'test@example.test',
    now,
  })
  return outcome.quote.id
}

/** Met une notification en file pour une nouvelle demande. */
async function enqueue(now = NOW, quoteRequestId = 0) {
  const quoteId = quoteRequestId === 0 ? await createQuote(now) : quoteRequestId
  const queued = await enqueueQuoteNotification(database.db, {
    quoteRequestId: quoteId,
    recipient: RECIPIENT,
    subject: SUBJECT,
    bodyText: BODY,
    now,
  })
  return { quoteId, ...queued }
}

describe('mise en file d’une notification', () => {
  it('met en file une notification, puis ne la duplique pas', async () => {
    const quoteId = await createQuote()
    const first = await enqueueQuoteNotification(database.db, {
      quoteRequestId: quoteId,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW,
    })

    expect(first.alreadyQueued).toBe(false)
    expect(first.email).toMatchObject({
      quote_request_id: quoteId,
      recipient: RECIPIENT,
      subject: SUBJECT,
      body_text: BODY,
      status: 'pending',
      attempts: 0,
      next_attempt_at: NOW,
      last_error: null,
      sent_at: null,
      created_at: NOW,
    })

    // Un second appel ne crée pas de doublon : le client ne recevra pas deux fois
    // le même courriel, et le quota d'envoi n'est pas consommé deux fois.
    const again = await enqueueQuoteNotification(database.db, {
      quoteRequestId: quoteId,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW + 5,
    })
    expect(again).toEqual({ email: null, alreadyQueued: true })
    expect(again.email).toBeNull()
  })

  it('autorise un renvoi après un échec définitif, jamais après un envoi réussi', async () => {
    const quoteId = await createQuote()
    const queued = await enqueueQuoteNotification(database.db, {
      quoteRequestId: quoteId,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW,
    })
    const emailId = queued.email?.id ?? 0

    // Échec définitif : l'entrée est abandonnée, un nouveau courriel redevient
    // possible. Un marquage ne s'applique qu'à une entrée PRISE : on la prend
    // d'abord, comme le fait le traitement de la file.
    await claimEmailOutboxEntry(database.db, {
      emailId,
      maxAttempts: 1,
      now: NOW + 10,
    })
    await markEmailOutboxFailed(database.db, {
      emailId,
      errorCode: 'smtp_timeout',
      retryAfterSeconds: 60,
      maxAttempts: 1,
      now: NOW + 10,
    })
    const reQueued = await enqueueQuoteNotification(database.db, {
      quoteRequestId: quoteId,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW + 20,
    })
    expect(reQueued.alreadyQueued).toBe(false)
    expect(reQueued.email?.id).not.toBe(emailId)

    // Envoi réussi : plus aucun doublon possible pour cette demande.
    await claimEmailOutboxEntry(database.db, {
      emailId: reQueued.email?.id ?? 0,
      now: NOW + 30,
    })
    await markEmailOutboxSent(database.db, {
      emailId: reQueued.email?.id ?? 0,
      now: NOW + 30,
    })
    const afterSend = await enqueueQuoteNotification(database.db, {
      quoteRequestId: quoteId,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW + 40,
    })
    expect(afterSend).toEqual({ email: null, alreadyQueued: true })
  })

  it('refuse un destinataire invalide ou un corps vide', async () => {
    const quoteId = await createQuote()

    await expect(
      enqueueQuoteNotification(database.db, {
        quoteRequestId: quoteId,
        recipient: 'adresse-sans-arobase',
        subject: SUBJECT,
        bodyText: BODY,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(
      enqueueQuoteNotification(database.db, {
        quoteRequestId: quoteId,
        recipient: RECIPIENT,
        subject: SUBJECT,
        bodyText: '',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(
      enqueueQuoteNotification(database.db, {
        quoteRequestId: 999_999,
        recipient: RECIPIENT,
        subject: SUBJECT,
        bodyText: BODY,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('traitement de la file', () => {
  it('liste les entrées échues dans l’ordre, en écartant le futur et le plafond atteint', async () => {
    const dueQuote = await createQuote()
    const laterQuote = await createQuote()
    const cappedQuote = await createQuote()

    await enqueueQuoteNotification(database.db, {
      quoteRequestId: dueQuote,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW,
    })
    const later = await enqueueQuoteNotification(database.db, {
      quoteRequestId: laterQuote,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      notBefore: NOW + 3_600,
      now: NOW,
    })
    const capped = await enqueueQuoteNotification(database.db, {
      quoteRequestId: cappedQuote,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW,
    })
    // Deux échecs avec un plafond de deux tentatives : l'entrée est abandonnée.
    for (const at of [NOW + 1, NOW + 2]) {
      await claimEmailOutboxEntry(database.db, {
        emailId: capped.email?.id ?? 0,
        maxAttempts: 2,
        now: at,
      })
      await markEmailOutboxFailed(database.db, {
        emailId: capped.email?.id ?? 0,
        errorCode: 'smtp_timeout',
        retryAfterSeconds: 1,
        maxAttempts: 2,
        now: at,
      })
    }

    const due = await listDueEmailOutbox(database.db, {
      now: NOW + 10,
      maxAttempts: 5,
    })
    const dueIds = due.map((email) => email.id)
    const dueRow = await database.db
      .prepare(`SELECT id FROM email_outbox WHERE quote_request_id = ?1`)
      .bind(dueQuote)
      .first<{ id: number }>()
    expect(dueIds).toContain(dueRow?.id)
    // Un envoi repoussé dans le futur n'est pas repris maintenant.
    expect(dueIds).not.toContain(later.email?.id)
    // L'entrée en échec reste réessayable tant que la politique du service l'autorise.
    expect(dueIds).toContain(capped.email?.id)

    // Avec un plafond de deux tentatives, la même entrée est écartée : c'est la
    // couche service qui fixe la politique, la file ne fait que la respecter.
    const strict = await listDueEmailOutbox(database.db, {
      now: NOW + 10,
      maxAttempts: 2,
    })
    expect(strict.map((email) => email.id)).not.toContain(capped.email?.id)

    // À l'échéance du report, l'entrée redevient disponible.
    const laterDue = await listDueEmailOutbox(database.db, {
      now: NOW + 4_000,
      maxAttempts: 5,
    })
    expect(laterDue.map((email) => email.id)).toContain(later.email?.id)
  })

  it('marque un envoi réussi et refuse de le compter deux fois', async () => {
    const { email } = await enqueue()
    const emailId = email?.id ?? 0

    // Seule une entrée PRISE (sous bail) peut être marquée : c'est ce qui interdit
    // à deux traitements de comptabiliser le même envoi.
    const claimed = await claimEmailOutboxEntry(database.db, {
      emailId,
      now: NOW + 50,
    })
    expect(claimed).toMatchObject({ status: 'sending', attempts: 1 })
    expect(
      await markEmailOutboxSent(database.db, { emailId, now: NOW + 60 }),
    ).toMatchObject({
      id: emailId,
      status: 'sent',
      attempts: 1,
      sent_at: NOW + 60,
    })

    // Un second envoi ne peut pas être enregistré pour la même entrée : la couche
    // service ne peut donc pas facturer ni compter deux fois un envoi.
    expect(
      await markEmailOutboxSent(database.db, { emailId, now: NOW + 70 }),
    ).toBeNull()
    // Un échec après envoi n'a plus de sens non plus.
    expect(
      await markEmailOutboxFailed(database.db, {
        emailId,
        errorCode: 'smtp_timeout',
        retryAfterSeconds: 60,
        now: NOW + 80,
      }),
    ).toBeNull()
  })

  it('enregistre un échec, repousse l’essai, puis abandonne au plafond', async () => {
    const { email } = await enqueue()
    const emailId = email?.id ?? 0

    // Le traitement prend l'entrée, échoue, et programme la suite.
    await claimEmailOutboxEntry(database.db, {
      emailId,
      maxAttempts: 2,
      now: NOW + 100,
    })
    const retried = await markEmailOutboxFailed(database.db, {
      emailId,
      errorCode: 'provider_unavailable',
      retryAfterSeconds: 300,
      maxAttempts: 2,
      now: NOW + 100,
    })
    expect(retried).toMatchObject({
      id: emailId,
      status: 'pending',
      attempts: 1,
      next_attempt_at: NOW + 400,
      last_error: 'provider_unavailable',
    })

    // Deuxième tentative, à l'échéance : c'est le plafond qui tranche.
    await claimEmailOutboxEntry(database.db, {
      emailId,
      maxAttempts: 2,
      now: NOW + 400,
    })
    const abandoned = await markEmailOutboxFailed(database.db, {
      emailId,
      errorCode: 'provider_unavailable',
      retryAfterSeconds: 300,
      maxAttempts: 2,
      now: NOW + 400,
    })
    expect(abandoned).toMatchObject({ status: 'failed', attempts: 2 })
    expect(abandoned?.sent_at).toBeNull()

    // Au-delà du plafond, plus rien n'est enregistré : les tentatives ne dérivent pas.
    // La prise elle-même est refusée, donc aucun appel au fournisseur n'a lieu.
    expect(
      await claimEmailOutboxEntry(database.db, {
        emailId,
        maxAttempts: 2,
        now: NOW + 500,
      }),
    ).toBeNull()
    expect(
      await markEmailOutboxFailed(database.db, {
        emailId,
        errorCode: 'provider_unavailable',
        retryAfterSeconds: 300,
        maxAttempts: 2,
        now: NOW + 500,
      }),
    ).toBeNull()
  })

  it('purge les entrées envoyées assez anciennes, jamais celles en attente', async () => {
    const sentQuote = await createQuote()
    const pendingQuote = await createQuote()

    const sent = await enqueueQuoteNotification(database.db, {
      quoteRequestId: sentQuote,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW,
    })
    await claimEmailOutboxEntry(database.db, {
      emailId: sent.email?.id ?? 0,
      now: NOW + 5,
    })
    await markEmailOutboxSent(database.db, {
      emailId: sent.email?.id ?? 0,
      now: NOW + 10,
    })

    const pending = await enqueueQuoteNotification(database.db, {
      quoteRequestId: pendingQuote,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW,
    })

    // Trop récent : rien n'est purgé.
    expect(await purgeEmailOutbox(database.db, { sentBefore: NOW })).toBe(0)

    const purged = await purgeEmailOutbox(database.db, { sentBefore: NOW + 10 })
    expect(purged).toBeGreaterThanOrEqual(1)

    // La purge emporte les données personnelles de l'entrée envoyée…
    const removed = await database.db
      .prepare(
        `SELECT id, recipient, body_text FROM email_outbox WHERE id = ?1`,
      )
      .bind(sent.email?.id ?? 0)
      .first<{ id: number }>()
    expect(removed).toBeNull()

    // …et laisse intacte la notification encore à traiter.
    const kept = await database.db
      .prepare(`SELECT status FROM email_outbox WHERE id = ?1`)
      .bind(pending.email?.id ?? 0)
      .first<{ status: string }>()
    expect(kept?.status).toBe('pending')
  })
})

describe('retrouver une notification par sa référence publique', () => {
  it('rend la notification de la demande visée, jamais une autre', async () => {
    // La référence publique est la seule identité dont dispose l'exploitant : la
    // file, elle, ne connaît que des identifiants internes. La traduction doit être
    // exacte, sans quoi un outil d'envoi ciblé enverrait le mauvais courriel.
    const reference = 'DEV-2027-RETROUVE'
    const quote = await createQuoteRequest(database.db, {
      reference,
      idempotencyKey: `idem-${reference}`,
      phoneNormalized: '+261339955001',
      phoneRaw: '+261 33 99 55 001',
      description: 'Garde-corps extérieur en aluminium, 6 mètres linéaires.',
      contactName: 'Test local',
      contactEmail: 'test@example.test',
      now: NOW,
    })
    const queued = await enqueueQuoteNotification(database.db, {
      quoteRequestId: quote.quote.id,
      recipient: RECIPIENT,
      subject: SUBJECT,
      bodyText: BODY,
      now: NOW,
    })

    const found = await findEmailOutboxByReference(database.db, reference)
    expect(found?.id).toBe(queued.email?.id)
    expect(found).toMatchObject({
      quote_request_id: quote.quote.id,
      status: 'pending',
    })

    // Une référence inconnue ne rend rien : surtout pas « la première entrée venue ».
    expect(
      await findEmailOutboxByReference(database.db, 'DEV-2027-INCONNU1'),
    ).toBeNull()
    // Et elle reste trouvable après envoi : l'état est rendu tel quel, à charge pour
    // l'appelant de décider qu'il n'y a plus rien à faire.
    await claimEmailOutboxEntry(database.db, {
      emailId: found?.id ?? 0,
      now: NOW,
    })
    await markEmailOutboxSent(database.db, {
      emailId: found?.id ?? 0,
      now: NOW + 5,
    })
    const afterSend = await findEmailOutboxByReference(database.db, reference)
    expect(afterSend?.status).toBe('sent')
  })
})

describe('prise sous bail', () => {
  it('n’accorde qu’une prise à la fois et reprend après l’expiration du bail', async () => {
    const { email } = await enqueue()
    const emailId = email?.id ?? 0

    const first = await claimEmailOutboxEntry(database.db, {
      emailId,
      leaseSeconds: 60,
      maxAttempts: 5,
      now: NOW + 10,
    })
    // La prise fixe le bail : c'est aussi l'échéance à partir de laquelle l'entrée
    // pourra être reprise si le traitement disparaît sans rien marquer.
    expect(first).toMatchObject({
      id: emailId,
      status: 'sending',
      attempts: 1,
      next_attempt_at: NOW + 70,
    })

    // Deuxième traitement, même instant : la base refuse. C'est ce qui empêche deux
    // envois simultanés du même courriel.
    expect(
      await claimEmailOutboxEntry(database.db, {
        emailId,
        leaseSeconds: 60,
        maxAttempts: 5,
        now: NOW + 10,
      }),
    ).toBeNull()

    // Bail encore valide : toujours pas prenable, même plus tard.
    expect(
      await claimEmailOutboxEntry(database.db, {
        emailId,
        maxAttempts: 5,
        now: NOW + 69,
      }),
    ).toBeNull()

    // À l'échéance, l'entrée est reprise : un arrêt brutal ne bloque pas la file.
    const resumed = await claimEmailOutboxEntry(database.db, {
      emailId,
      leaseSeconds: 60,
      maxAttempts: 5,
      now: NOW + 70,
    })
    expect(resumed).toMatchObject({ status: 'sending', attempts: 2 })
  })

  it('refuse de marquer une entrée qui n’a jamais été prise', async () => {
    const { email } = await enqueue()
    const emailId = email?.id ?? 0

    // Sans prise préalable, ni succès ni échec ne peuvent être inscrits : un
    // traitement ne peut donc pas compter un envoi qu'il n'a pas effectué.
    expect(
      await markEmailOutboxSent(database.db, { emailId, now: NOW + 10 }),
    ).toBeNull()
    expect(
      await markEmailOutboxFailed(database.db, {
        emailId,
        errorCode: 'timeout',
        retryAfterSeconds: 60,
        now: NOW + 10,
      }),
    ).toBeNull()

    // L'entrée est intacte : ni essai compté, ni erreur inscrite.
    const row = await database.db
      .prepare(
        `SELECT status, attempts, last_error FROM email_outbox WHERE id = ?1`,
      )
      .bind(emailId)
      .first<{ status: string; attempts: number; last_error: string | null }>()
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 0,
      last_error: null,
    })
  })
})
