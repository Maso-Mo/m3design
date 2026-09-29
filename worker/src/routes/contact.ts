/**
 * Route de soumission d'un message de contact.
 *
 *   POST /api/contact  { name, email, phone?, message, idempotencyKey?,
 *                        website?, turnstileToken? }
 *
 * Même contrat que `POST /api/devis` (voir `routes/devis.ts`) : nom et adresse
 * électronique obligatoires, téléphone FACULTATIF et jamais vérifié, texte
 * obligatoire, champ leurre, défi anti-robot facultatif. Seuls le nom du champ de
 * texte (`message` au lieu de `description`) et celui du service changent — d'où
 * une symétrie volontaire entre les deux routes, qui rend une divergence visible.
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
  submitContactMessage,
  type ContactRequestLogger,
} from '../services/contact-request'
import {
  NotificationConfigurationError,
  readNotificationRecipient,
} from '../services/notifications'
import { readClientIp } from '../services/quote-request'
import { HONEYPOT_FIELD } from '../services/request-fields'
import type { AppEnv } from '../types'

/** Dépendances injectables (tests) : aucun fournisseur d'envoi n'est nécessaire. */
export type ContactRouteDependencies = {
  now?: () => number
  contactLog?: ContactRequestLogger
  rateLimitSecret?: string
  turnstileSecret?: string
  /** Plafonds de limitation, réduits par les tests (anti-abus). */
  abusePolicy?: AbusePolicy
  fetchImplementation?: typeof fetch
}

/** Messages publics : aucune cause interne, aucune donnée du formulaire. */
const MESSAGES = {
  invalidBody: 'Le corps de la requête doit être un objet JSON valide.',
  invalidRequest:
    'Le message est incomplet ou mal formé : vérifiez votre nom, votre adresse électronique et votre message.',
  challengeFailed:
    'La vérification anti-robot a échoué. Rechargez la page puis réessayez.',
  tooManyRequests:
    'Trop de messages ont été envoyés récemment. Merci de réessayer dans un moment.',
  serviceUnavailable: 'Le service des messages est momentanément indisponible.',
} as const

/** Construit la route des messages de contact. */
export function createContactRoute(
  dependencies: ContactRouteDependencies = {},
): Hono<AppEnv> {
  const route = new Hono<AppEnv>()

  route.post('/contact', async (c) => {
    let notificationRecipient: string
    try {
      notificationRecipient = readNotificationRecipient(c.env)
    } catch (error) {
      const reason =
        error instanceof NotificationConfigurationError
          ? error.code
          : 'unexpected'
      console.error(`[api] service des messages indisponible (${reason})`)
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
        '[api] service des messages indisponible (rate_limit_secret_missing)',
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
    const message = readTextField(body.value, 'message')
    const phone = readOptionalTextField(body.value, 'phone')
    const idempotencyKey = readOptionalTextField(body.value, 'idempotencyKey')
    const honeypot = readOptionalTextField(body.value, HONEYPOT_FIELD)
    const turnstileToken = readOptionalTextField(body.value, 'turnstileToken')

    if (
      name === null ||
      email === null ||
      message === null ||
      !phone.ok ||
      !idempotencyKey.ok ||
      !honeypot.ok ||
      !turnstileToken.ok
    ) {
      return apiError(c, 400, 'invalid_request', MESSAGES.invalidRequest)
    }

    const result = await submitContactMessage({
      db: c.env.DB,
      notificationRecipient,
      rateLimitSecret,
      name,
      email,
      message,
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
      ...(dependencies.contactLog === undefined
        ? {}
        : { log: dependencies.contactLog }),
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
