/**
 * Tests des fournisseurs d'envoi de courriel, sans réseau et sans base.
 *
 * Deux familles d'exigences structurent ce fichier :
 *
 *   1. la SÉLECTION refuse toute configuration incomplète, et surtout tout nom de
 *      fournisseur fictif : un « console » qui accepte tout sans rien envoyer
 *      laisserait croire que les demandes partent ;
 *
 *   2. un fournisseur ne dit « accepté » que si le service distant a renvoyé un
 *      identifiant de message, et il ne recopie JAMAIS la réponse du service dans
 *      un code d'erreur : celle-ci peut contenir l'adresse du destinataire.
 *
 * `fetch` est injecté par un espion (`helpers/fetch.ts`) : les tests vérifient donc
 * ce qui serait réellement transmis — URL, en-tête `Authorization`, corps — sans
 * qu'aucune socket ne soit ouverte.
 */

import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_EMAIL_PROVIDER,
  EmailConfigurationError,
  REFUSED_FAKE_EMAIL_PROVIDERS,
  RESEND_PROVIDER,
  readEmailSender,
} from '../src/providers/email-provider'
import { createCloudflareEmailProvider } from '../src/providers/cloudflare-email'
import {
  RESEND_API_BASE_URL,
  createResendEmailProvider,
} from '../src/providers/resend'
import { createFetchSpy } from './helpers/fetch'
import type { FetchSpy } from './helpers/fetch'
import type { EmailSendResult, OutboundEmail } from '../src/providers/messaging'

/** Clé fictive : même forme qu'une clé Resend, valeur inventée. */
const API_KEY = 're_cle_de_test_0123456789'

/** Adresse d'expédition fictive (domaine réservé, RFC 2606). */
const FROM = 'notifications@m3design.test'

/** Adresse de destination fictive : aucune boîte réelle ne peut être visée. */
const TO = 'aina@example.test'

const EMAIL: OutboundEmail = {
  to: TO,
  subject: 'Nouvelle demande de devis DEV-2027-00000001',
  bodyText: 'Portail coulissant en aluminium, largeur 4 m, hors pose.',
}

/** Codes d'échec autorisés : liste fermée, recopiée ici pour être vérifiée. */
const CLOSED_FAILURE_CODES: readonly string[] = [
  'invalid_recipient',
  'sender_not_verified',
  'recipient_undeliverable',
  'auth_failed',
  'rate_limited',
  'provider_unavailable',
  'endpoint_not_found',
  'request_rejected',
  'unexpected_response',
  'network_error',
  'timeout',
]

/** Réponse JSON, comme celle d'une API HTTP. */
function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Réponse sans corps utile (page d'erreur d'un intermédiaire, corps vide). */
function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  })
}

/** Construit le fournisseur Resend avec l'espion injecté. */
function buildResend(spy: FetchSpy) {
  return createResendEmailProvider({
    apiKey: API_KEY,
    from: FROM,
    fetchImplementation: spy.fetchImplementation,
  })
}

/** Vérifie qu'un échec est bien un échec, avec un code de la liste fermée. */
function expectFailure(result: EmailSendResult, code: string): void {
  expect(result.accepted).toBe(false)
  expect(result.errorCode).toBe(code)
  expect(CLOSED_FAILURE_CODES).toContain(result.errorCode)
}

/**
 * Code d'erreur d'une configuration refusée.
 *
 * Le message d'une erreur de configuration ne contient jamais de valeur : c'est le
 * CODE qui porte la décision, et c'est donc lui que les tests comparent.
 */
function configurationCodeOf(
  source: Parameters<typeof readEmailSender>[0],
): string {
  try {
    readEmailSender(source)
  } catch (error) {
    if (error instanceof EmailConfigurationError) {
      return error.code
    }
    throw error
  }
  throw new Error('configuration acceptée alors qu’elle devait être refusée')
}

describe('sélection du fournisseur', () => {
  it('refuse une configuration absente, inconnue ou fictive', () => {
    // Rien de configuré : le passage périodique doit s'arrêter net, pas envoyer
    // dans le vide.
    expect(configurationCodeOf({})).toBe('email_provider_missing')
    expect(configurationCodeOf({ EMAIL_PROVIDER: 'postmark' })).toBe(
      'email_provider_unknown',
    )

    // Aucun nom de double de test n'est accepté, dans aucun environnement : c'est
    // la même règle que pour l'envoi des codes WhatsApp.
    for (const name of REFUSED_FAKE_EMAIL_PROVIDERS) {
      expect(configurationCodeOf({ EMAIL_PROVIDER: name })).toBe(
        'email_provider_fake_refused',
      )
    }
  })

  it('exige une adresse d’expédition valide, une clé et un délai conformes', () => {
    const valid = {
      EMAIL_PROVIDER: RESEND_PROVIDER,
      EMAIL_FROM_ADDRESS: FROM,
      RESEND_API_KEY: API_KEY,
    }
    const cases: {
      label: string
      source: Parameters<typeof readEmailSender>[0]
      expected: string
    }[] = [
      {
        label: 'adresse absente',
        source: { EMAIL_PROVIDER: RESEND_PROVIDER, RESEND_API_KEY: API_KEY },
        expected: 'email_from_missing',
      },
      {
        label: 'adresse sans domaine',
        source: { ...valid, EMAIL_FROM_ADDRESS: 'adresse-sans-arobase' },
        expected: 'email_from_invalid',
      },
      {
        // Une adresse en majuscules est refusée : le schéma l'exigerait de toute
        // façon (`ck_email_outbox_recipient`), autant le dire avant tout envoi.
        label: 'adresse en majuscules',
        source: { ...valid, EMAIL_FROM_ADDRESS: 'Notifications@M3Design.test' },
        expected: 'email_from_invalid',
      },
      {
        // Un nom affiché qui contient des chevrons pourrait fabriquer un second
        // expéditeur : il est refusé.
        label: 'nom affiché à chevrons',
        source: { ...valid, EMAIL_FROM_NAME: 'M3Design <autre@adresse.test>' },
        expected: 'email_from_invalid',
      },
      {
        label: 'clé absente',
        source: { EMAIL_PROVIDER: RESEND_PROVIDER, EMAIL_FROM_ADDRESS: FROM },
        expected: 'email_api_key_missing',
      },
      {
        label: 'clé avec des espaces',
        source: { ...valid, RESEND_API_KEY: 're_cle avec des espaces' },
        expected: 'email_api_key_invalid',
      },
      {
        label: 'délai illisible',
        source: { ...valid, EMAIL_TIMEOUT_MS: 'deux-mille' },
        expected: 'email_timeout_invalid',
      },
      {
        label: 'délai hors bornes',
        source: { ...valid, EMAIL_TIMEOUT_MS: '60000' },
        expected: 'email_timeout_invalid',
      },
    ]

    for (const testCase of cases) {
      expect(
        `${testCase.label} : ${configurationCodeOf(testCase.source)}`,
      ).toBe(`${testCase.label} : ${testCase.expected}`)
    }
  })

  it('ne recopie jamais une valeur fautive dans le message d’erreur', () => {
    const secret = 're_secret_a_ne_pas_journaliser'
    try {
      // Espace inclus dans la clé : le motif de forme la refuse.
      readEmailSender({
        EMAIL_PROVIDER: RESEND_PROVIDER,
        EMAIL_FROM_ADDRESS: FROM,
        RESEND_API_KEY: `${secret} et suite`,
      })
      throw new Error('la configuration aurait dû être refusée')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      expect(message).not.toContain(secret)
      // Le NOM de la variable, lui, est indispensable pour corriger.
      expect(message).toContain('RESEND_API_KEY')
    }
  })

  it('construit le fournisseur Resend, nom affiché compris', () => {
    const sender = readEmailSender({
      EMAIL_PROVIDER: RESEND_PROVIDER,
      EMAIL_FROM_ADDRESS: FROM,
      EMAIL_FROM_NAME: 'M3Design',
      RESEND_API_KEY: API_KEY,
    })

    expect(sender.from).toBe(FROM)
    expect(sender.fromName).toBe('M3Design')
    expect(typeof sender.provider.send).toBe('function')
  })

  it('exige le binding EMAIL pour la voie Cloudflare', () => {
    // Le binding n'est pas déclaré dans wrangler.jsonc : la voie Cloudflare est
    // refusée avec un motif précis, plutôt que d'échouer au premier envoi.
    expect(
      configurationCodeOf({
        EMAIL_PROVIDER: CLOUDFLARE_EMAIL_PROVIDER,
        EMAIL_FROM_ADDRESS: FROM,
      }),
    ).toBe('email_binding_missing')
  })
})

describe('fournisseur Resend', () => {
  it('transmet le courriel attendu, jeton dans l’en-tête, texte brut', async () => {
    const spy = createFetchSpy(() => jsonResponse({ id: 'msg_123' }))
    const provider = buildResend(spy)

    const result = await provider.send(EMAIL)

    expect(result).toEqual({ accepted: true, providerMessageId: 'msg_123' })
    expect(spy.calls).toHaveLength(1)
    const call = spy.calls[0]
    expect(call?.url).toBe(`${RESEND_API_BASE_URL}/emails`)
    expect(call?.method).toBe('POST')
    // Le jeton ne vit que dans cet en-tête : jamais dans l'URL, qui finit dans des
    // journaux intermédiaires.
    expect(call?.headers.authorization).toBe(`Bearer ${API_KEY}`)

    const body = JSON.parse(call?.body ?? '{}') as Record<string, unknown>
    expect(body).toEqual({
      from: FROM,
      to: [TO],
      subject: EMAIL.subject,
      text: EMAIL.bodyText,
    })
    // Aucun champ HTML : le courriel est du texte, et rien d'autre.
    expect(Object.keys(body)).not.toContain('html')
  })

  it('accepte un nom affiché dans l’adresse d’expédition', async () => {
    const spy = createFetchSpy(() => jsonResponse({ id: 'msg_1' }))
    const provider = createResendEmailProvider({
      apiKey: API_KEY,
      from: `M3Design <${FROM}>`,
      fetchImplementation: spy.fetchImplementation,
    })

    await provider.send(EMAIL)

    const body = JSON.parse(spy.calls[0]?.body ?? '{}') as { from?: string }
    expect(body.from).toBe(`M3Design <${FROM}>`)
  })

  it('exige un identifiant de message pour annoncer une acceptation', async () => {
    // 200 sans identifiant exploitable : rien ne prouve que Resend a pris le
    // message en charge, donc c'est un échec.
    const empty = createFetchSpy(() => jsonResponse({}))
    expectFailure(await buildResend(empty).send(EMAIL), 'unexpected_response')

    const odd = createFetchSpy(() => jsonResponse({ id: '   ' }))
    expectFailure(await buildResend(odd).send(EMAIL), 'unexpected_response')

    // Corps illisible (page d'erreur d'un intermédiaire réseau en HTML).
    const html = createFetchSpy(() => textResponse('<html>oups</html>', 200))
    expectFailure(await buildResend(html).send(EMAIL), 'unexpected_response')
  })
})

it('traduit les refus de l’API en codes techniques fermés', async () => {
  const cases: {
    label: string
    status: number
    expected: string
  }[] = [
    { label: 'jeton refusé', status: 401, expected: 'auth_failed' },
    { label: 'accès interdit', status: 403, expected: 'auth_failed' },
    { label: 'URL erronée', status: 404, expected: 'endpoint_not_found' },
    { label: 'validation refusée', status: 422, expected: 'invalid_recipient' },
    { label: 'quota atteint', status: 429, expected: 'rate_limited' },
    {
      label: 'panne du service',
      status: 503,
      expected: 'provider_unavailable',
    },
    { label: 'requête refusée', status: 400, expected: 'request_rejected' },
  ]

  for (const testCase of cases) {
    const spy = createFetchSpy(() =>
      // Le corps d'erreur peut recopier l'adresse du destinataire : il ne doit
      // jamais ressortir du fournisseur.
      jsonResponse({ message: `refus pour ${TO}` }, testCase.status),
    )
    const result = await buildResend(spy).send(EMAIL)
    expect(`${testCase.label} : ${result.errorCode}`).toBe(
      `${testCase.label} : ${testCase.expected}`,
    )
    expect(JSON.stringify(result)).not.toContain(TO)
  }
})

it('reprend le délai annoncé par le fournisseur, quand il est exploitable', async () => {
  const throttled = createFetchSpy(() =>
    jsonResponse({ message: 'trop de requêtes' }, 429, {
      'retry-after': '120',
    }),
  )
  expect(await buildResend(throttled).send(EMAIL)).toEqual({
    accepted: false,
    errorCode: 'rate_limited',
    retryAfterSeconds: 120,
  })

  // Forme « date HTTP » et valeur aberrante : ignorées, la couche service
  // appliquera sa propre progression.
  const dated = createFetchSpy(() =>
    jsonResponse({}, 429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
  )
  expect(await buildResend(dated).send(EMAIL)).toEqual({
    accepted: false,
    errorCode: 'rate_limited',
  })

  const absurd = createFetchSpy(() =>
    jsonResponse({}, 429, { 'retry-after': '99999' }),
  )
  expect(await buildResend(absurd).send(EMAIL)).toEqual({
    accepted: false,
    errorCode: 'rate_limited',
  })
})

it('distingue une panne réseau d’un délai dépassé', async () => {
  const broken = createFetchSpy(() => {
    throw new TypeError(`impossible de joindre le service (${TO})`)
  })
  expectFailure(await buildResend(broken).send(EMAIL), 'network_error')

  const timedOut = createFetchSpy(() => {
    const error = new Error('délai dépassé')
    error.name = 'TimeoutError'
    throw error
  })
  expectFailure(await buildResend(timedOut).send(EMAIL), 'timeout')
})

describe('fournisseur Cloudflare (binding send_email)', () => {
  it('transmet le courriel au binding et retient son identifiant', async () => {
    const calls: unknown[] = []
    const provider = createCloudflareEmailProvider({
      from: FROM,
      fromName: 'M3Design',
      binding: {
        send: (message: unknown) => {
          calls.push(message)
          return Promise.resolve({ messageId: 'cf-msg-1' })
        },
      } as SendEmail,
    })

    const result = await provider.send(EMAIL)

    expect(result).toEqual({ accepted: true, providerMessageId: 'cf-msg-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      from: { name: 'M3Design', email: FROM },
      to: TO,
      subject: EMAIL.subject,
      text: EMAIL.bodyText,
    })
  })

  it('envoie une adresse simple quand aucun nom n’est configuré', async () => {
    const calls: unknown[] = []
    const provider = createCloudflareEmailProvider({
      from: FROM,
      binding: {
        send: (message: unknown) => {
          calls.push(message)
          return Promise.resolve({ messageId: 'cf-msg-2' })
        },
      } as SendEmail,
    })

    await provider.send(EMAIL)

    expect((calls[0] as { from?: unknown }).from).toBe(FROM)
  })

  it('traduit les erreurs du binding sans recopier leur message', async () => {
    const cases: { error: unknown; expected: string }[] = [
      {
        error: {
          code: 'E_SENDER_NOT_VERIFIED',
          message: `envoi refusé vers ${TO}`,
        },
        expected: 'sender_not_verified',
      },
      {
        error: { code: 'E_RECIPIENT_NOT_VERIFIED', message: TO },
        expected: 'recipient_undeliverable',
      },
      { error: { code: 'E_OTHER_THING' }, expected: 'request_rejected' },
      {
        error: new Error(`panne interne pour ${TO}`),
        expected: 'provider_unavailable',
      },
      { error: null, expected: 'provider_unavailable' },
    ]

    for (const testCase of cases) {
      const provider = createCloudflareEmailProvider({
        from: FROM,
        binding: {
          send: () => Promise.reject(testCase.error),
        } as SendEmail,
      })
      const result = await provider.send(EMAIL)
      expectFailure(result, testCase.expected)
      // Ni l'adresse ni le message du binding ne ressortent.
      expect(JSON.stringify(result)).not.toContain(TO)
    }
  })

  it('refuse d’annoncer une acceptation sans identifiant', async () => {
    const provider = createCloudflareEmailProvider({
      from: FROM,
      binding: {
        send: () => Promise.resolve({ messageId: '' }),
      } as SendEmail,
    })

    expectFailure(await provider.send(EMAIL), 'unexpected_response')
  })
})
