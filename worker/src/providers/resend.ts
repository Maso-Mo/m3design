/**
 * Envoi des notifications par l'API HTTP de Resend.
 *
 * Pourquoi ce fournisseur : il fonctionne partout où `fetch` existe (donc dans un
 * Worker), il s'active avec une simple clé d'API, et son offre gratuite suffit
 * largement à nos premiers tests. Comme tout module qui parle à un service
 * externe, il applique les mêmes règles que tout accès sortant du projet :
 *
 *   * aucun secret ici : la clé d'API vient de l'environnement du Worker
 *     (`.dev.vars` en local, `wrangler secret put RESEND_API_KEY` en ligne) ;
 *   * la réponse du fournisseur n'est JAMAIS relayée, journalisée ni recopiée dans
 *     un message d'erreur : elle contient l'adresse du destinataire et le sujet.
 *     Seuls des codes d'échec fermés, courts et techniques, sortent d'ici ;
 *   * un échec est un RÉSULTAT (`accepted: false`), jamais une exception ;
 *   * un courriel n'est considéré comme ACCEPTÉ que si le fournisseur a renvoyé un
 *     identifiant de message. Une réponse 2xx sans identifiant exploitable est
 *     traitée comme un échec : c'est le seul moyen de ne pas marquer « envoyée »
 *     une notification qui n'a pas été prise en charge.
 *
 * Le corps envoyé est TOUJOURS en texte brut (`text`), jamais en HTML : il vient
 * de `services/notifications.ts`, qui n'écrit que du texte — pas de contenu actif,
 * pas de suivi d'ouverture.
 */

import {
  INTEGER_PATTERN,
  isAbortFailure,
  readJsonPayload,
  readRetryAfterSeconds,
} from './http'
import type {
  EmailProvider,
  EmailSendFailureCode,
  EmailSendResult,
  OutboundEmail,
} from './messaging'

/** Base de l'API Resend. Constante : aucune URL ne vient d'une entrée client. */
export const RESEND_API_BASE_URL = 'https://api.resend.com'

/** Délai maximal d'un appel au fournisseur. Au-delà, l'envoi est abandonné. */
export const DEFAULT_RESEND_TIMEOUT_MS = 10_000

/** Délai d'attente : jamais moins d'une seconde, jamais plus de trente. */
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 30_000

/**
 * Forme attendue d'une clé d'API Resend.
 *
 * Ce motif n'a pas pour but de valider l'existence de la clé (seul un appel réel le
 * peut) mais d'empêcher qu'une valeur contenant des espaces, des retours à la ligne
 * ou des caractères de contrôle soit insérée dans un en-tête HTTP : c'est une
 * protection contre l'injection d'en-tête.
 */
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{8,256}$/

/** Identifiant de message Resend : caractères techniques, longueur bornée. */
const PROVIDER_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:=+/-]{1,200}$/

/**
 * Traduit l'état HTTP en code interne.
 *
 * `422` est le refus de validation de Resend (destinataire ou expéditeur refusé) :
 * il est classé `invalid_recipient`, la cause la plus probable et la plus utile au
 * support. Un `404` signale une URL d'API erronée — un défaut de notre côté, jamais
 * un défaut du destinataire.
 */
function failureCodeFromStatus(status: number): EmailSendFailureCode {
  if (status === 401 || status === 403) {
    return 'auth_failed'
  }
  if (status === 404) {
    return 'endpoint_not_found'
  }
  if (status === 422) {
    return 'invalid_recipient'
  }
  if (status === 429) {
    return 'rate_limited'
  }
  if (status >= 500) {
    return 'provider_unavailable'
  }
  return 'request_rejected'
}

/**
 * Extrait l'identifiant du message accepté.
 *
 * Renvoie `null` — donc un échec — si le corps est inexploitable : sans
 * identifiant, rien ne prouve que le fournisseur a pris le message en charge.
 */
function readProviderMessageId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const id = (payload as { id?: unknown }).id
  if (typeof id !== 'string') {
    return null
  }
  const trimmed = id.trim()
  return PROVIDER_MESSAGE_ID_PATTERN.test(trimmed) ? trimmed : null
}

/** Lit un délai de configuration, sans recopier sa valeur dans l'erreur. */
export function readResendTimeoutMs(
  value: string | number | undefined,
): number | undefined {
  const raw = value === undefined ? '' : String(value).trim()
  if (raw === '') {
    return undefined
  }
  if (!INTEGER_PATTERN.test(raw)) {
    throw new RangeError('resend_timeout_invalid')
  }
  const timeoutMs = Number(raw)
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError('resend_timeout_invalid')
  }
  return timeoutMs
}

/** Configuration du fournisseur, déjà extraite et validée par la sélection. */
export type ResendEmailProviderConfig = {
  /** Clé d'API (secrète). Jamais journalisée, jamais recopiée dans une erreur. */
  apiKey: string
  /** Adresse d'expédition, au format « Nom <adresse> » ou « adresse ». */
  from: string
  timeoutMs?: number
  /** Injecté par les tests ; en production, le `fetch` global du runtime. */
  fetchImplementation?: typeof fetch
}

/**
 * Construit le fournisseur Resend.
 *
 * La configuration est vérifiée ici, une fois : une clé absente ou mal formée fait
 * échouer la construction AVANT tout envoi, et l'erreur ne contient jamais la
 * valeur fautive.
 */
export function createResendEmailProvider(
  config: ResendEmailProviderConfig,
): EmailProvider {
  const apiKey = config.apiKey.trim()
  const from = config.from.trim()
  const timeoutMs = config.timeoutMs ?? DEFAULT_RESEND_TIMEOUT_MS

  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new RangeError('resend_api_key_invalid')
  }
  if (from === '' || /[\r\n]/.test(from)) {
    throw new RangeError('resend_from_invalid')
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError('resend_timeout_invalid')
  }

  const sendWith = config.fetchImplementation ?? fetch

  return {
    async send(email: OutboundEmail): Promise<EmailSendResult> {
      let response: Response
      try {
        response = await sendWith(`${RESEND_API_BASE_URL}/emails`, {
          method: 'POST',
          headers: {
            // La clé n'apparaît que dans cet en-tête, jamais dans l'URL : les URL
            // finissent dans les journaux des intermédiaires réseau.
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [email.to],
            subject: email.subject,
            // Texte brut uniquement : voir l'en-tête de ce module.
            text: email.bodyText,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        // Aucune donnée personnelle, aucun message d'exception recopié : la cause
        // suffit au diagnostic, et un délai dépassé n'est pas une panne réseau.
        return {
          accepted: false,
          errorCode: isAbortFailure(error) ? 'timeout' : 'network_error',
        }
      }

      const payload = await readJsonPayload(response)

      if (response.ok) {
        const providerMessageId = readProviderMessageId(payload)
        if (providerMessageId === null) {
          return { accepted: false, errorCode: 'unexpected_response' }
        }
        return { accepted: true, providerMessageId }
      }

      const retryAfterSeconds = readRetryAfterSeconds(response)
      return {
        accepted: false,
        errorCode: failureCodeFromStatus(response.status),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      }
    },
  }
}
