/**
 * Tests du traitement périodique du Worker (`scheduled`).
 *
 * C'est le point de jonction entre Cloudflare et la file : il reçoit une invocation
 * planifiée, lit la configuration, délègue l'envoi, puis purge les notifications
 * anciennes. Trois comportements comptent, et sont vérifiés ici :
 *
 *   1. sans configuration d'envoi complète, le passage est ANNULÉ avant toute
 *      écriture : les notifications restent en attente, intactes. Une file ne doit
 *      jamais perdre une demande parce qu'une variable manque ;
 *   2. configuré, il envoie les notifications dues et inscrit un bilan ;
 *   3. il purge les notifications acceptées depuis plus de trente jours, en
 *      emportant l'adresse du destinataire et le texte du message.
 *
 * Aucun envoi réel : le fournisseur est injecté par les dépendances.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { enqueueQuoteNotification } from '../src/db/repositories/email-outbox'
import { createQuoteRequest } from '../src/db/repositories/quote-requests'
import { createScheduledHandler } from '../src/scheduled'
import type { AppEnv } from '../src/types'
import {
  clearOperationalTables,
  createTestDatabase,
  type TestDatabase,
} from './helpers/database'
import { createTestClock } from './helpers/api'
import { createEmailProviderSpy } from './helpers/email'

/** Instant de référence : 2027-01-15T08:00:00Z. */
const NOW = 1_800_000_000
/** Expression de planification déclarée dans wrangler.jsonc. */
const CRON = '*/5 * * * *'
const RECIPIENT = 'notifications@m3design.test'
const SUBJECT = 'Nouvelle demande de devis DEV-2027-00000001'
const BODY = 'Portail coulissant en aluminium, largeur 4 m, hors pose.'
/** Trente et un jours : au-delà de la conservation, donc purgeable. */
const BEYOND_RETENTION = 31 * 24 * 60 * 60

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.dispose()
})

beforeEach(async () => {
  await clearOperationalTables(database.db)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Contrôleur planifié minimal, tel que le runtime en fournit un. */
function scheduledController(): ScheduledController {
  return {
    cron: CRON,
    scheduledTime: NOW * 1000,
    type: 'scheduled',
    noRetry: () => undefined,
  } as ScheduledController
}

/** Environnement du Worker réduit à ce que ce traitement utilise. */
function workerEnvironment(overrides: Record<string, unknown> = {}) {
  return { DB: database.db, ...overrides } as unknown as AppEnv['Bindings']
}

let sequence = 0

/** Crée une demande de test et met sa notification en file. */
async function enqueue(now = NOW): Promise<number> {
  sequence += 1
  const reference = `DEV-2027-${String(sequence).padStart(8, '0')}`
  const quote = await createQuoteRequest(database.db, {
    reference,
    idempotencyKey: `idem-${reference}`,
    phoneNormalized: `+2613399${String(20_000 + sequence)}`,
    phoneRaw: `+2613399${String(20_000 + sequence)}`,
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
  return queued.email?.id ?? 0
}

/** Ligne de la file, ou `null` si elle a été purgée. */
function readRow(emailId: number): Promise<{
  status: string
  attempts: number
  recipient: string
  body_text: string
} | null> {
  return database.db
    .prepare(
      `SELECT status, attempts, recipient, body_text FROM email_outbox WHERE id = ?1`,
    )
    .bind(emailId)
    .first<{
      status: string
      attempts: number
      recipient: string
      body_text: string
    }>()
}

describe('traitement planifié', () => {
  it('annule le passage sans configuration, sans toucher à la file', async () => {
    const emailId = await enqueue()
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    // Aucune variable d'envoi : ni fournisseur, ni adresse d'expédition.
    await createScheduledHandler()(scheduledController(), workerEnvironment())

    // Rien n'a été tenté : l'entrée est intacte, aucun essai compté.
    expect(await readRow(emailId)).toMatchObject({
      status: 'pending',
      attempts: 0,
    })
    const logged = errors.mock.calls.flat().join(' ')
    expect(logged).toContain('pass_skipped')
    expect(logged).toContain('email_provider_missing')
    // Et rien de personnel : ni destinataire, ni sujet.
    expect(logged).not.toContain(RECIPIENT)
  })

  it('annule le passage quand la politique d’envoi est mal formée', async () => {
    const emailId = await enqueue()
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await createScheduledHandler()(
      scheduledController(),
      workerEnvironment({
        // Fournisseur complet, mais plafond de tentatives illisible : rien ne doit
        // être envoyé avec une politique qu'on croit appliquée.
        EMAIL_PROVIDER: 'resend',
        EMAIL_FROM_ADDRESS: 'notifications@m3design.test',
        RESEND_API_KEY: 're_cle_de_test_0123456789',
        EMAIL_MAX_ATTEMPTS: 'beaucoup',
      }),
    )

    expect(await readRow(emailId)).toMatchObject({
      status: 'pending',
      attempts: 0,
    })
    const logged = errors.mock.calls.flat().join(' ')
    expect(logged).toContain('email_max_attempts_invalid')
  })

  it('envoie les notifications dues, puis purge celles qui sont anciennes', async () => {
    const clock = createTestClock(NOW)
    const spy = createEmailProviderSpy({
      results: [{ accepted: true, providerMessageId: 'msg-planifie' }],
    })
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const handler = createScheduledHandler({
      provider: spy.provider,
      now: () => clock.now(),
    })

    // Premier passage : la notification part.
    const first = await enqueue()
    await handler(scheduledController(), workerEnvironment())
    expect(spy.sent).toHaveLength(1)
    expect(await readRow(first)).toMatchObject({ status: 'sent', attempts: 1 })

    const firstLog = logs.mock.calls.flat().join(' ')
    expect(firstLog).toContain('pass_done')
    expect(firstLog).toContain(CRON)
    expect(firstLog).not.toContain(RECIPIENT)

    // Un mois et un jour plus tard, une nouvelle demande arrive.
    clock.advance(BEYOND_RETENTION)
    const second = await enqueue(clock.now())
    await handler(scheduledController(), workerEnvironment())

    // La notification ancienne a été purgée : adresse et texte ont disparu…
    expect(await readRow(first)).toBeNull()
    // …et la nouvelle est envoyée, donc conservée le temps de la politique.
    expect(await readRow(second)).toMatchObject({ status: 'sent', attempts: 1 })

    // Le bilan du dernier passage annonce la purge.
    const lastLog = logs.mock.calls.at(-1)?.join(' ') ?? ''
    expect(lastLog).toContain('pass_done')
    expect(lastLog).toContain('"purged":1')
  })
})
