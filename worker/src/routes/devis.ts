/**
 * Route de soumission d'une demande de devis.
 *
 *   POST /api/devis  { name, email, phone?, description, idempotencyKey?,
 *                      website?, turnstileToken? }
 *
 * `name` et `email` sont obligatoires, `description` aussi (10 à 2000 caractères) ;
 * `phone` est FACULTATIF et n'est jamais présenté comme vérifié. `website` est un
 * champ leurre qui doit rester vide (voir `services/abuse-guard.ts`), et
 * `turnstileToken` n'est exigé que si le défi est configuré côté serveur.
 *
 * Réponses :
 *   * `201` la demande vient d'être créée ;
 *   * `200` la même clé d'idempotence avait déjà produit une demande (double clic,
 *     réessai réseau) : la MÊME référence est renvoyée, rien n'a été créé ;
 *   * `400` saisie refusée (`invalid_request`) ou défi non résolu
 *     (`challenge_failed`) ;
 *   * `409` une demande existe déjà pour ce numéro (`request_rejected`) ;
 *   * `429` trop de soumissions (`too_many_requests`, avec `Retry-After`) ;
 *   * `503` service indisponible (configuration incomplète, base injoignable).
 *
 * Cette couche ne valide rien elle-même : elle lit le corps, traduit et répond. Le
 * service possède les règles, la base possède les garanties.
 */

import { Hono } from 'hono'
import { apiError } from '../lib/api-error'
import {
  readJsonObject,
  readOptionalTextField,
  readTextField,
} from '../lib/json-body'
import { readRateLimitSecret } from '../services/abuse-guard'
import type { AbusePolicy } from '../services/abuse-guard'
import {
  NotificationConfigurationError,
  readNotificationRecipient,
} from '../services/notifications'
import { readClientIp, submitQuoteRequest } from '../services/quote-request'
import type { QuoteRequestLogger } from '../services/quote-request'
import { HONEYPOT_FIELD } from '../services/request-fields'
import type { AppEnv } from '../types'

/** Dépendances injectables (tests) : aucun fournisseur d'envoi n'est nécessaire. */
export type QuoteRouteDependencies = {
  /** Horloge en secondes Unix (tests). */
  now?: () => number
  /** Journal du service de devis (tests). */
  quoteLog?: QuoteRequestLogger
  /** Secret de limitation, injecté pour ne pas dépendre de `.dev.vars`. */
  rateLimitSecret?: string
  /** Secret Turnstile : sa présence active le défi. */
  turnstileSecret?: string
  /** Plafonds de limitation, réduits par les tests (anti-abus). */
  abusePolicy?: AbusePolicy
  /** `fetch` utilisé pour vérifier le défi (tests). */
  fetchImplementation?: typeof fetch
}

/** Messages publics : aucune cause interne, aucune donnée du formulaire. */
const MESSAGES = {
  invalidBody: 'Le corps de la requête doit être un objet JSON valide.',
  invalidRequest:
    'La demande est incomplète ou mal formée : vérifiez votre nom, votre adresse électronique et la description de votre projet.',
  challengeFailed:
    'La vérification anti-robot a échoué. Rechargez la page puis réessayez.',
  requestRejected:
    'Une demande est déjà enregistrée pour ce numéro de téléphone.',
  tooManyRequests:
    'Trop de demandes ont été envoyées récemment. Merci de réessayer dans un moment.',
  serviceUnavailable: 'Le service des demandes est momentanément indisponible.',
} as const

/** Construit la route des demandes de devis. */
export function createQuoteRoute(
  dependencies: QuoteRouteDependencies = {},
): Hono<AppEnv> {
  const route = new Hono<AppEnv>()

  route.post('/devis', async (c) => {
    // Deux pré-requis de configuration, lus AVANT toute écriture : la boîte de
    // notification (sinon la demande ne serait vue par personne) et le secret de
    // limitation d'abus. Les deux mènent au même 503, avec un motif journalisé qui
    // nomme la variable manquante — jamais sa valeur.
    let notificationRecipient: string
    try {
      notificationRecipient = readNotificationRecipient(c.env)
    } catch (error) {
      const reason =
        error instanceof NotificationConfigurationError
          ? error.code
          : 'unexpected'
      console.error(`[api] service des demandes indisponible (${reason})`)
      return apiError(
        c,
        503,
        'service_unavailable',
        MESSAGES.serviceUnavailable,
      )
    }

    // Le secret injecté (tests) passe par la MÊME validation que celui de
    // l'environnement : une valeur trop courte est refusée dans les deux cas.
    const rateLimitSecret = readRateLimitSecret({
      RATE_LIMIT_SECRET:
        dependencies.rateLimitSecret ?? c.env.RATE_LIMIT_SECRET ?? '',
    })
    if (rateLimitSecret === null) {
      console.error(
        '[api] service des demandes indisponible (rate_limit_secret_missing)',
      )
      return apiError(
        c,
        503,
        'service_unavailable',
        MESSAGES.serviceUnavailable,
      )
    }

    const body = await readJsonObject(c)
    if (!body.ok) {
      return apiError(c, 400, 'invalid_request', MESSAGES.invalidBody)
    }

    const name = readTextField(body.value, 'name')
    const email = readTextField(body.value, 'email')
    const description = readTextField(body.value, 'description')
    const phone = readOptionalTextField(body.value, 'phone')
    const idempotencyKey = readOptionalTextField(body.value, 'idempotencyKey')
    const honeypot = readOptionalTextField(body.value, HONEYPOT_FIELD)
    const turnstileToken = readOptionalTextField(body.value, 'turnstileToken')

    if (
      name === null ||
      email === null ||
      description === null ||
      !phone.ok ||
      !idempotencyKey.ok ||
      !honeypot.ok ||
      !turnstileToken.ok
    ) {
      return apiError(c, 400, 'invalid_request', MESSAGES.invalidRequest)
    }

    const result = await submitQuoteRequest({
      db: c.env.DB,
      notificationRecipient,
      rateLimitSecret,
      name,
      email,
      description,
      phone: phone.value,
      idempotencyKey: idempotencyKey.value,
      honeypot: honeypot.value,
      turnstileToken: turnstileToken.value,
      clientIp: readClientIp(c.req.header('cf-connecting-ip')),
      ...(dependencies.turnstileSecret === undefined
        ? {}
        : { turnstileSecret: dependencies.turnstileSecret }),
      ...(dependencies.abusePolicy === undefined
        ? {}
        : { abusePolicy: dependencies.abusePolicy }),
      ...(dependencies.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: dependencies.fetchImplementation }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
      ...(dependencies.quoteLog === undefined
        ? {}
        : { log: dependencies.quoteLog }),
    })

    if (result.ok) {
      return c.json(
        {
          reference: result.reference,
          status: result.status,
          replayed: result.replayed,
          notificationQueued: result.notificationQueued,
          phoneMasked: result.phoneMasked,
          submittedAt: result.submittedAt,
        },
        result.replayed ? 200 : 201,
      )
    }

    switch (result.code) {
      case 'invalid_request':
        return apiError(c, 400, 'invalid_request', MESSAGES.invalidRequest)
      case 'challenge_failed':
        return apiError(c, 400, 'challenge_failed', MESSAGES.challengeFailed)
      case 'request_rejected':
        return apiError(c, 409, 'request_rejected', MESSAGES.requestRejected)
      case 'too_many_requests':
        return apiError(
          c,
          429,
          'too_many_requests',
          MESSAGES.tooManyRequests,
          result.retryAfterSeconds,
        )
      case 'service_unavailable':
        return apiError(
          c,
          503,
          'service_unavailable',
          MESSAGES.serviceUnavailable,
        )
    }
  })

  return route
}
