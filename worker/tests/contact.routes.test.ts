/**
 * Tests de la route de soumission d'un message de contact (parcours V1, sans OTP).
 *
 * La route de contact partage tout son contrat avec celle des devis (validation,
 * anti-abus, idempotence, mise en file de la notification) : les cas exhaustifs
 * vivent donc dans `devis.routes.test.ts`. Ce fichier couvre ce qui est PROPRE au
 * contact — le champ `message`, la référence « MSG », le contenu du courriel — et
 * reprend les garanties structurantes pour que la seconde route ne puisse pas
 * diverger en silence.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import type { AppEnv } from '../src/types'
import type { AbusePolicy } from '../src/services/abuse-guard'
import {
  TEST_NOTIFICATION_EMAIL,
  TEST_RATE_LIMIT_SECRET,
  createTestClock,
  createTestEnvironment,
  postJson,
  readBodyText,
  readErrorCode,
  readJsonBody,
  type TestClock,
  type TestEnvironment,
} from './helpers/api'
import {
  clearOperationalTables,
  createTestDatabase,
  type TestDatabase,
} from './helpers/database'

/** Instant de départ des tests, en secondes Unix. */
const NOW = 1_800_000_000
const NAME = 'Léa Rakoto'
const EMAIL = 'lea@example.com'
const PHONE = '+261 34 98 76 543'
const PHONE_NORMALIZED = '+261349876543'
const MESSAGE =
  'Bonjour, je souhaite un rendez-vous pour poser un parquet, 40 m².'
const IDEMPOTENCY_KEY = 'cle-contact-0000000001'

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

type Harness = {
  app: Hono<AppEnv>
  clock: TestClock
  env: TestEnvironment
  logEntries: unknown[]
}

function createHarness(
  options: {
    env?: Partial<TestEnvironment>
    rateLimitSecret?: string | undefined
    turnstileSecret?: string
    abusePolicy?: AbusePolicy
    fetchImplementation?: typeof fetch
  } = {},
): Harness {
  const clock = createTestClock(NOW)
  const logEntries: unknown[] = []
  const app = createApp({
    now: clock.now,
    contactLog: (entry) => {
      logEntries.push(entry)
    },
    ...(options.rateLimitSecret === undefined
      ? { rateLimitSecret: TEST_RATE_LIMIT_SECRET }
      : { rateLimitSecret: options.rateLimitSecret }),
    ...(options.turnstileSecret === undefined
      ? {}
      : { turnstileSecret: options.turnstileSecret }),
    ...(options.abusePolicy === undefined
      ? {}
      : { abusePolicy: options.abusePolicy }),
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
  })
  return {
    app,
    clock,
    env: createTestEnvironment(database.db, options.env),
    logEntries,
  }
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    name: NAME,
    email: EMAIL,
    phone: PHONE,
    message: MESSAGE,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  }
}

function submitContact(
  harness: Harness,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return postJson(harness.app, '/api/contact', body, harness.env, headers)
}

type ContactBody = {
  reference: string
  status: string
  replayed: boolean
  notificationQueued: boolean
  phoneMasked: string | null
  submittedAt: number
}

async function countRows(table: string): Promise<number> {
  const row = await database.db
    .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
    .first<{ total: number }>()
  return row?.total ?? 0
}

describe('POST /api/contact — création et contenu', () => {
  it('crée un message, son événement et sa notification, et rien de plus', async () => {
    const harness = createHarness()

    const response = await submitContact(harness, submission())

    expect(response.status).toBe(201)
    const body = await readJsonBody<ContactBody>(response)
    expect(body.reference).toMatch(/^MSG-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(body.status).toBe('new')
    expect(body.replayed).toBe(false)
    expect(body.notificationQueued).toBe(true)
    expect(body.phoneMasked).toBe('+2613••••••43')
    expect(body.submittedAt).toBe(NOW)

    expect(await countRows('contact_messages')).toBe(1)
    expect(await countRows('request_events')).toBe(1)
    expect(await countRows('email_outbox')).toBe(1)

    const message = await database.db
      .prepare(
        `SELECT reference, status, intake_version, phone_normalized, contact_name,
                contact_email, message
           FROM contact_messages`,
      )
      .first<Record<string, unknown>>()
    expect(message).toMatchObject({
      reference: body.reference,
      status: 'new',
      intake_version: 2,
      phone_normalized: PHONE_NORMALIZED,
      contact_name: NAME,
      contact_email: EMAIL,
      message: MESSAGE,
    })

    const event = await database.db
      .prepare(
        `SELECT event_type, from_status, to_status, contact_message_id
           FROM request_events`,
      )
      .first<Record<string, unknown>>()
    expect(event).toMatchObject({
      event_type: 'created',
      from_status: null,
      to_status: 'new',
      // L'événement désigne le MESSAGE, pas une demande de devis.
      contact_message_id: 1,
    })

    const outbox = await database.db
      .prepare(`SELECT recipient, subject, body_text FROM email_outbox`)
      .first<Record<string, unknown>>()
    expect(outbox).toMatchObject({
      recipient: TEST_NOTIFICATION_EMAIL,
      subject: `Nouveau message de contact ${body.reference}`,
    })

    const bodyText = String(outbox?.body_text)
    expect(bodyText).toContain('Nouveau message de contact')
    expect(bodyText).toContain(`Nom : ${NAME}`)
    expect(bodyText).toContain(`Adresse électronique : ${EMAIL}`)
    expect(bodyText).toContain(`Téléphone : ${PHONE_NORMALIZED}`)
    expect(bodyText).toContain(MESSAGE)
    // Aucune trace de l'étape abandonnée, dans le corps comme dans la réponse.
    expect(bodyText.toLowerCase()).not.toContain('whatsapp')
    expect(bodyText.toLowerCase()).not.toContain('otp')
    expect(bodyText).not.toContain('vérifi')
    const raw = await readBodyText(response)
    expect(raw).not.toContain(NAME)
    expect(raw).not.toContain(MESSAGE)
    const logs = JSON.stringify(harness.logEntries)
    expect(logs).toContain('contact.submit')
    expect(logs).not.toContain(NAME)
    expect(logs).not.toContain(EMAIL)
    expect(logs).not.toContain(MESSAGE)
  })

  it('accepte un message sans téléphone', async () => {
    const harness = createHarness()
    const response = await submitContact(harness, submission({ phone: null }))
    expect(response.status).toBe(201)
    expect((await readJsonBody<ContactBody>(response)).phoneMasked).toBeNull()
  })
})

describe('POST /api/contact — validation', () => {
  const refusals: { label: string; body: Record<string, unknown> }[] = [
    { label: 'nom absent', body: submission({ name: '' }) },
    {
      label: 'adresse mal formée',
      body: submission({ email: 'sans-arobase' }),
    },
    { label: 'message trop court', body: submission({ message: 'court' }) },
    {
      label: 'message trop long',
      body: submission({ message: 'a'.repeat(2001) }),
    },
    {
      label: 'téléphone sans indicatif',
      body: submission({ phone: '0349876543' }),
    },
  ]

  for (const refusal of refusals) {
    it(`refuse une soumission : ${refusal.label}`, async () => {
      const harness = createHarness()
      const response = await submitContact(harness, refusal.body)
      expect(response.status).toBe(400)
      expect(await readErrorCode(response)).toBe('invalid_request')
      expect(await countRows('contact_messages')).toBe(0)
      expect(await countRows('email_outbox')).toBe(0)
    })
  }
})

describe('POST /api/contact — idempotence et anti-abus', () => {
  it('rejoue un envoi déjà abouti sans rien créer de plus', async () => {
    const harness = createHarness()

    const created = await submitContact(harness, submission())
    expect(created.status).toBe(201)
    const first = await readJsonBody<ContactBody>(created)

    const replayed = await submitContact(harness, submission())
    expect(replayed.status).toBe(200)
    const second = await readJsonBody<ContactBody>(replayed)
    expect(second.reference).toBe(first.reference)
    expect(second.replayed).toBe(true)
    expect(second.notificationQueued).toBe(false)

    expect(await countRows('contact_messages')).toBe(1)
    expect(await countRows('request_events')).toBe(1)
    expect(await countRows('email_outbox')).toBe(1)
  })

  it('ne crée jamais deux messages pour deux envois simultanés', async () => {
    const harness = createHarness()

    const [first, second] = await Promise.all([
      submitContact(harness, submission()),
      submitContact(harness, submission()),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 201])
    expect(await countRows('contact_messages')).toBe(1)
    expect(await countRows('request_events')).toBe(1)
    expect(await countRows('email_outbox')).toBe(1)
  })

  it('refuse une soumission dont le champ leurre est rempli', async () => {
    const harness = createHarness()
    const response = await submitContact(
      harness,
      submission({ website: 'https://spam.example' }),
    )
    expect(response.status).toBe(400)
    expect(await readErrorCode(response)).toBe('invalid_request')
    expect(await countRows('contact_messages')).toBe(0)
    expect(await countRows('rate_limit_hits')).toBe(1)
  })

  it('limite le débit par adresse électronique', async () => {
    const harness = createHarness({
      abusePolicy: {
        ipMax: 50,
        ipWindowSeconds: 3600,
        emailMax: 1,
        emailWindowSeconds: 86_400,
        phoneMax: 50,
        phoneWindowSeconds: 86_400,
      },
    })

    expect((await submitContact(harness, submission())).status).toBe(201)
    const limited = await submitContact(
      harness,
      submission({ idempotencyKey: 'cle-contact-0000000002' }),
    )
    expect(limited.status).toBe(429)
    expect(await readErrorCode(limited)).toBe('too_many_requests')
    expect(limited.headers.get('retry-after')).toBe('86400')
    // Le message refusé n'a rien laissé derrière lui.
    expect(await countRows('contact_messages')).toBe(1)
  })

  it('exige le défi Turnstile dès qu’il est configuré', async () => {
    const harness = createHarness({
      turnstileSecret: 'secret-turnstile-de-test',
      fetchImplementation: () =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), { status: 200 }),
        ),
    })

    const missing = await submitContact(harness, submission())
    expect(missing.status).toBe(400)
    expect(await readErrorCode(missing)).toBe('challenge_failed')

    const accepted = await submitContact(
      harness,
      submission({ turnstileToken: 'jeton-de-test' }),
    )
    expect(accepted.status).toBe(201)
  })
})

describe('POST /api/contact — configuration', () => {
  it('répond 503 sans boîte de notification ni secret de limitation', async () => {
    const noMailbox = createHarness({ env: { NOTIFICATION_EMAIL: '' } })
    const mailboxResponse = await submitContact(noMailbox, submission())
    expect(mailboxResponse.status).toBe(503)
    expect(await readErrorCode(mailboxResponse)).toBe('service_unavailable')

    const noSecret = createHarness({ rateLimitSecret: '' })
    const secretResponse = await submitContact(noSecret, submission())
    expect(secretResponse.status).toBe(503)
    expect(await readErrorCode(secretResponse)).toBe('service_unavailable')

    expect(await countRows('contact_messages')).toBe(0)
    expect(await countRows('email_outbox')).toBe(0)
  })
})
