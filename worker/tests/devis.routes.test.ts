/**
 * Tests de la route de soumission d'une demande de devis (parcours V1, sans OTP).
 *
 * Les formulaires publics sont désormais ouverts : il n'y a plus de preuve de
 * vérification, et la protection repose sur la validation, l'anti-abus et les
 * garanties de la base. Ces tests vérifient exactement cela, au niveau HTTP :
 *
 *   * une demande valide est créée, avec sa référence, son événement et SA
 *     notification — une seule, dans le même lot ;
 *   * une saisie incomplète est refusée (nom, adresse, texte, téléphone mal formé) ;
 *   * le champ leurre, la limitation de débit et le défi anti-robot sont appliqués ;
 *   * un rejeu (même clé d'idempotence) renvoie la MÊME référence sans rien créer ;
 *   * deux soumissions simultanées ne produisent jamais deux demandes ;
 *   * une configuration incomplète répond 503 sans rien écrire ;
 *   * aucune donnée personnelle ne sort par les journaux ou la réponse HTTP.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createApp } from '../src/app'
import type { AppEnv } from '../src/types'
import { DEFAULT_ABUSE_POLICY } from '../src/services/abuse-guard'
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

const NAME = 'Aina Rakoto'
const EMAIL = 'aina@example.com'
const PHONE = '+261 34 12 34 567'
const PHONE_NORMALIZED = '+261341234567'
const DESCRIPTION = 'Rénovation complète de la salle de bain, environ 6 m².'
const IDEMPOTENCY_KEY = 'cle-de-test-0000000001'

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
    start?: number
    rateLimitSecret?: string | undefined
    turnstileSecret?: string
    abusePolicy?: AbusePolicy
    fetchImplementation?: typeof fetch
  } = {},
): Harness {
  const clock = createTestClock(options.start ?? NOW)
  const logEntries: unknown[] = []
  const app = createApp({
    now: clock.now,
    quoteLog: (entry) => {
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

/** Corps de soumission complet. */
function submission(overrides: Record<string, unknown> = {}) {
  return {
    name: NAME,
    email: EMAIL,
    phone: PHONE,
    description: DESCRIPTION,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  }
}

function submitQuote(
  harness: Harness,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return postJson(harness.app, '/api/devis', body, harness.env, headers)
}

type QuoteBody = {
  reference: string
  status: string
  replayed: boolean
  notificationQueued: boolean
  phoneMasked: string | null
  submittedAt: number
}

/** Compte les lignes d'une table opérationnelle. */
async function countRows(table: string): Promise<number> {
  const row = await database.db
    .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
    .first<{ total: number }>()
  return row?.total ?? 0
}

describe('POST /api/devis — création', () => {
  it('crée une demande, son événement et sa notification, et rien de plus', async () => {
    const harness = createHarness()

    const response = await submitQuote(harness, submission())

    expect(response.status).toBe(201)
    const body = await readJsonBody<QuoteBody>(response)
    expect(body.reference).toMatch(/^DEV-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{8}$/)
    // Une demande reçue naît « new » : la notion de numéro vérifié n'existe plus.
    expect(body.status).toBe('new')
    expect(body.replayed).toBe(false)
    expect(body.notificationQueued).toBe(true)
    expect(body.phoneMasked).toBe('+2613••••••67')
    expect(body.submittedAt).toBe(NOW)

    // Exactement une demande, un événement, une notification.
    expect(await countRows('quote_requests')).toBe(1)
    expect(await countRows('request_events')).toBe(1)
    expect(await countRows('email_outbox')).toBe(1)

    const quote = await database.db
      .prepare(
        `SELECT reference, status, intake_version, phone_normalized, contact_name,
                contact_email, description
           FROM quote_requests`,
      )
      .first<Record<string, unknown>>()
    expect(quote).toMatchObject({
      reference: body.reference,
      status: 'new',
      intake_version: 2,
      phone_normalized: PHONE_NORMALIZED,
      contact_name: NAME,
      contact_email: EMAIL,
      description: DESCRIPTION,
    })

    const event = await database.db
      .prepare(
        `SELECT event_type, from_status, to_status, actor FROM request_events`,
      )
      .first<Record<string, unknown>>()
    expect(event).toEqual({
      event_type: 'created',
      from_status: null,
      to_status: 'new',
      actor: 'client',
    })

    const outbox = await database.db
      .prepare(`SELECT recipient, subject, body_text, status FROM email_outbox`)
      .first<Record<string, unknown>>()
    expect(outbox).toMatchObject({
      recipient: TEST_NOTIFICATION_EMAIL,
      subject: `Nouvelle demande de devis ${body.reference}`,
      status: 'pending',
    })

    // Le courriel contient ce qu'il faut pour traiter la demande…
    const bodyText = String(outbox?.body_text)
    expect(bodyText).toContain(`Référence : ${body.reference}`)
    expect(bodyText).toContain(`Nom : ${NAME}`)
    expect(bodyText).toContain(`Adresse électronique : ${EMAIL}`)
    expect(bodyText).toContain(`Téléphone : ${PHONE_NORMALIZED}`)
    expect(bodyText).toContain(DESCRIPTION)
    // …et AUCUNE mention de vérification ni de code (l'étape WhatsApp est close).
    expect(bodyText.toLowerCase()).not.toContain('whatsapp')
    expect(bodyText.toLowerCase()).not.toContain('otp')
    expect(bodyText).not.toContain('vérifi')

    // La réponse ne restitue jamais le nom ni la description.
    const raw = await readBodyText(response)
    expect(raw).not.toContain(NAME)
    expect(raw).not.toContain(DESCRIPTION)
    // Et les journaux ne portent que des codes et un numéro masqué.
    const logs = JSON.stringify(harness.logEntries)
    expect(logs).toContain('quote.submit')
    expect(logs).not.toContain(NAME)
    expect(logs).not.toContain(EMAIL)
    expect(logs).not.toContain(DESCRIPTION)
    expect(logs).not.toContain(PHONE_NORMALIZED)
  })

  it('accepte une demande sans téléphone (champ facultatif)', async () => {
    const harness = createHarness()

    const response = await submitQuote(harness, submission({ phone: null }))

    expect(response.status).toBe(201)
    const body = await readJsonBody<QuoteBody>(response)
    expect(body.phoneMasked).toBeNull()
    const quote = await database.db
      .prepare(`SELECT phone_normalized, phone_raw FROM quote_requests`)
      .first<Record<string, unknown>>()
    expect(quote).toEqual({ phone_normalized: null, phone_raw: null })
  })
})

describe('POST /api/devis — validation des champs', () => {
  const refusals: { label: string; body: Record<string, unknown> }[] = [
    { label: 'nom absent', body: submission({ name: '' }) },
    { label: 'nom trop long', body: submission({ name: 'a'.repeat(121) }) },
    { label: 'adresse absente', body: submission({ email: '' }) },
    {
      label: 'adresse mal formée',
      body: submission({ email: 'pas-une-adresse' }),
    },
    {
      label: 'description trop courte',
      body: submission({ description: 'court' }),
    },
    {
      label: 'description trop longue',
      body: submission({ description: 'a'.repeat(2001) }),
    },
    {
      label: 'téléphone mal formé',
      body: submission({ phone: '0341234567' }),
    },
    {
      label: 'clé d’idempotence suspecte',
      body: submission({ idempotencyKey: 'clé avec des espaces' }),
    },
  ]

  for (const refusal of refusals) {
    it(`refuse une soumission : ${refusal.label}`, async () => {
      const harness = createHarness()

      const response = await submitQuote(harness, refusal.body)

      expect(response.status).toBe(400)
      expect(await readErrorCode(response)).toBe('invalid_request')
      // Rien n'a été écrit : ni demande, ni événement, ni notification.
      expect(await countRows('quote_requests')).toBe(0)
      expect(await countRows('request_events')).toBe(0)
      expect(await countRows('email_outbox')).toBe(0)
    })
  }

  it('refuse un corps qui n’est pas un objet JSON', async () => {
    const harness = createHarness()
    const response = await postJson(
      harness.app,
      '/api/devis',
      'texte',
      harness.env,
    )
    expect(response.status).toBe(400)
    expect(await readErrorCode(response)).toBe('invalid_request')
  })
})

describe('POST /api/devis — idempotence et concurrence', () => {
  it('rejoue un envoi déjà abouti sans rien créer de plus', async () => {
    const harness = createHarness()

    const created = await submitQuote(harness, submission())
    expect(created.status).toBe(201)
    const first = await readJsonBody<QuoteBody>(created)

    const replayed = await submitQuote(harness, submission())
    expect(replayed.status).toBe(200)
    const second = await readJsonBody<QuoteBody>(replayed)
    expect(second.reference).toBe(first.reference)
    expect(second.replayed).toBe(true)
    expect(second.notificationQueued).toBe(false)

    // Une seule demande, un seul événement, une seule notification.
    expect(await countRows('quote_requests')).toBe(1)
    expect(await countRows('request_events')).toBe(1)
    expect(await countRows('email_outbox')).toBe(1)
  })

  it('ne crée jamais deux demandes pour deux envois simultanés', async () => {
    const harness = createHarness()

    const [first, second] = await Promise.all([
      submitQuote(harness, submission()),
      submitQuote(harness, submission()),
    ])
    const statuses = [first.status, second.status].sort()
    // Une création et un rejeu (200), dans un ordre ou dans l’autre.
    expect(statuses).toEqual([200, 201])

    const bodies = [
      await readJsonBody<QuoteBody>(first),
      await readJsonBody<QuoteBody>(second),
    ]
    expect(bodies[0]?.reference).toBe(bodies[1]?.reference)
    expect(await countRows('quote_requests')).toBe(1)
    expect(await countRows('request_events')).toBe(1)
    expect(await countRows('email_outbox')).toBe(1)
  })

  it('refuse une seconde demande active pour le même téléphone', async () => {
    const harness = createHarness()

    expect((await submitQuote(harness, submission())).status).toBe(201)

    const conflict = await submitQuote(
      harness,
      submission({ idempotencyKey: 'cle-de-test-0000000002' }),
    )
    expect(conflict.status).toBe(409)
    expect(await readErrorCode(conflict)).toBe('request_rejected')
    expect(await countRows('quote_requests')).toBe(1)
    expect(await countRows('email_outbox')).toBe(1)
  })
})

describe('POST /api/devis — anti-abus', () => {
  const SMALL_POLICY: AbusePolicy = {
    ipMax: 2,
    ipWindowSeconds: 3600,
    emailMax: 2,
    emailWindowSeconds: 86_400,
    phoneMax: 2,
    phoneWindowSeconds: 86_400,
  }

  it('refuse une soumission dont le champ leurre est rempli', async () => {
    const harness = createHarness()

    const response = await submitQuote(
      harness,
      submission({ website: 'https://spam.example' }),
    )

    expect(response.status).toBe(400)
    expect(await readErrorCode(response)).toBe('invalid_request')
    expect(await countRows('quote_requests')).toBe(0)
    // La tentative est comptée malgré tout : un robot qui insiste s'arrête seul.
    expect(await countRows('rate_limit_hits')).toBe(1)
    expect(JSON.stringify(harness.logEntries)).toContain('abuse_honeypot')
  })

  it('limite le débit par adresse réseau, sans bloquer les autres visiteurs', async () => {
    const harness = createHarness({ abusePolicy: SMALL_POLICY })
    const headers = { 'cf-connecting-ip': '203.0.113.10' }

    const first = await submitQuote(harness, submission(), headers)
    const second = await submitQuote(
      harness,
      submission({
        email: 'autre@example.com',
        phone: null,
        idempotencyKey: 'cle-de-test-0000000002',
      }),
      headers,
    )
    expect([first.status, second.status]).toEqual([201, 201])

    // Troisième envoi depuis la même adresse : refusé, avec l'attente conseillée.
    const third = await submitQuote(
      harness,
      submission({
        email: 'troisieme@example.com',
        phone: null,
        idempotencyKey: 'cle-de-test-0000000003',
      }),
      headers,
    )
    expect(third.status).toBe(429)
    expect(await readErrorCode(third)).toBe('too_many_requests')
    expect(third.headers.get('retry-after')).toBe(
      String(SMALL_POLICY.ipWindowSeconds),
    )
    const error = await readJsonBody<{
      error: { retryAfterSeconds?: number }
    }>(third)
    expect(error.error.retryAfterSeconds).toBe(SMALL_POLICY.ipWindowSeconds)

    // Une AUTRE adresse réseau reste libre : la limite ne pénalise pas tout le monde.
    const other = await submitQuote(
      harness,
      submission({
        email: 'quatrieme@example.com',
        phone: null,
        idempotencyKey: 'cle-de-test-0000000004',
      }),
      { 'cf-connecting-ip': '203.0.113.11' },
    )
    expect(other.status).toBe(201)
  })

  it('limite le débit par adresse électronique, même depuis des réseaux différents', async () => {
    const harness = createHarness({ abusePolicy: SMALL_POLICY })

    const first = await submitQuote(harness, submission({ phone: null }), {
      'cf-connecting-ip': '203.0.113.20',
    })
    const second = await submitQuote(
      harness,
      submission({ phone: null, idempotencyKey: 'cle-de-test-0000000002' }),
      { 'cf-connecting-ip': '203.0.113.21' },
    )
    expect([first.status, second.status]).toEqual([201, 201])

    const third = await submitQuote(
      harness,
      submission({ phone: null, idempotencyKey: 'cle-de-test-0000000003' }),
      { 'cf-connecting-ip': '203.0.113.22' },
    )
    expect(third.status).toBe(429)
  })

  it('exige le défi Turnstile dès qu’il est configuré', async () => {
    const calls: string[] = []
    const verified = createHarness({
      turnstileSecret: 'secret-turnstile-de-test',
      fetchImplementation: (input: RequestInfo | URL) => {
        calls.push(String(input))
        return Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      },
    })

    // Jeton absent : refus explicite, sans appel réseau.
    const missing = await submitQuote(verified, submission())
    expect(missing.status).toBe(400)
    expect(await readErrorCode(missing)).toBe('challenge_failed')
    expect(calls).toEqual([])

    // Jeton présent et validé par Cloudflare : le formulaire passe.
    const accepted = await submitQuote(
      verified,
      submission({ turnstileToken: 'jeton-de-test' }),
    )
    expect(accepted.status).toBe(201)
    expect(calls).toEqual([
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    ])
  })

  it('refuse un défi non résolu et distingue une panne de Cloudflare', async () => {
    const refused = createHarness({
      turnstileSecret: 'secret-turnstile-de-test',
      fetchImplementation: () =>
        Promise.resolve(
          new Response(JSON.stringify({ success: false }), { status: 200 }),
        ),
    })
    const refusedResponse = await submitQuote(
      refused,
      submission({ turnstileToken: 'mauvais-jeton' }),
    )
    expect(refusedResponse.status).toBe(400)
    expect(await readErrorCode(refusedResponse)).toBe('challenge_failed')
    expect(await countRows('quote_requests')).toBe(0)

    // Cloudflare injoignable : ce n'est pas la faute du visiteur, donc 503 et non 400.
    const broken = createHarness({
      turnstileSecret: 'secret-turnstile-de-test',
      fetchImplementation: () => Promise.reject(new TypeError('réseau coupé')),
    })
    const brokenResponse = await submitQuote(
      broken,
      submission({ turnstileToken: 'jeton-de-test' }),
    )
    expect(brokenResponse.status).toBe(503)
    expect(await readErrorCode(brokenResponse)).toBe('service_unavailable')
  })
})

describe('POST /api/devis — configuration', () => {
  it('répond 503 sans boîte de notification, sans rien écrire', async () => {
    const harness = createHarness({ env: { NOTIFICATION_EMAIL: '' } })

    const response = await submitQuote(harness, submission())

    expect(response.status).toBe(503)
    expect(await readErrorCode(response)).toBe('service_unavailable')
    expect(await countRows('quote_requests')).toBe(0)
    expect(await countRows('email_outbox')).toBe(0)
  })

  it('répond 503 sans secret de limitation, sans rien écrire', async () => {
    const harness = createHarness({ rateLimitSecret: '' })

    const response = await submitQuote(harness, submission())

    expect(response.status).toBe(503)
    expect(await readErrorCode(response)).toBe('service_unavailable')
    expect(await countRows('quote_requests')).toBe(0)
  })

  it('applique une politique par défaut prudente', () => {
    // Garde-fou de documentation : ces valeurs sont celles annoncées dans le README.
    expect(DEFAULT_ABUSE_POLICY.ipMax).toBe(20)
    expect(DEFAULT_ABUSE_POLICY.emailMax).toBe(5)
    expect(DEFAULT_ABUSE_POLICY.phoneMax).toBe(5)
  })
})
