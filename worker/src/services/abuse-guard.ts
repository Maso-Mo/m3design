/**
 * Protection des formulaires publics contre les soumissions automatisées.
 *
 * Depuis l'abandon de la vérification par code, les formulaires sont ouverts : il
 * faut donc d'autres garde-fous. Ce module en réunit trois, du moins coûteux au plus
 * précis, et n'en ajoute AUCUN qui demande une donnée supplémentaire au visiteur :
 *
 *   1. un champ LEURRE (pot de miel) qui doit rester vide : un robot qui remplit tous
 *      les champs se dénonce lui-même, un humain ne le voit pas ;
 *   2. la LIMITATION DE DÉBIT par empreinte (adresse IP, adresse électronique,
 *      téléphone) : les tentatives sont comptées dans une fenêtre glissante, sur des
 *      empreintes HMAC — jamais sur les valeurs, qui ne sont donc pas stockées ;
 *   3. TURNSTILE (facultatif) : si `TURNSTILE_SECRET` est configuré, le jeton du
 *      widget Cloudflare est vérifié auprès de Cloudflare. C'est gratuit et sans
 *      cookie, mais cela suppose le widget côté front : d'où le caractère facultatif,
 *      activable le jour où le formulaire React enverra un jeton.
 *
 * Deux principes de réglage :
 *   * la limite par IP est VOLONTAIREMENT généreuse (20 par heure) : plusieurs
 *     visiteurs peuvent partager une adresse (bureau, opérateur mobile, réseau
 *     public), et les bloquer serait une faute commerciale. Les limites par adresse
 *     électronique et par téléphone, plus fines, sont le vrai frein ;
 *   * une tentative est comptée AVANT la décision, y compris refusée : c'est ce qui
 *     rend la limitation fiable face à des requêtes simultanées.
 *
 * Ce module ne journalise rien : il rend une décision, et c'est la couche service qui
 * décide de ce qui est consigné (jamais une adresse, jamais un numéro).
 */

import { nowSeconds } from '../db/client'
import type { Db } from '../db/client'
import {
  countRateLimitHits,
  recordRateLimitHit,
} from '../db/repositories/rate-limit'
import type { RateLimitScope } from '../db/repositories/rate-limit'
import { hmacSha256Hex } from '../lib/crypto'
import { isHoneypotFilled } from './request-fields'

/** Variables d'environnement lues par ce module (noms, jamais de valeur). */
export type AbuseGuardEnvironmentSource = {
  /** Secret de hachage des empreintes de limitation. Obligatoire. */
  RATE_LIMIT_SECRET?: string
  /** Secret Turnstile. Facultatif : son absence désactive le défi. */
  TURNSTILE_SECRET?: string
}

/** Réglages de limitation. Valeurs par défaut, surchargeables par les tests. */
export type AbusePolicy = {
  ipMax: number
  ipWindowSeconds: number
  emailMax: number
  emailWindowSeconds: number
  phoneMax: number
  phoneWindowSeconds: number
}

export const DEFAULT_ABUSE_POLICY: AbusePolicy = {
  ipMax: 20,
  ipWindowSeconds: 3600,
  emailMax: 5,
  emailWindowSeconds: 86_400,
  phoneMax: 5,
  phoneWindowSeconds: 86_400,
}

/** Motifs internes de refus. Ils restent dans les journaux. */
export type AbuseRefusalReason =
  | 'honeypot'
  | 'challenge_invalid'
  | 'ip_rate_limited'
  | 'email_rate_limited'
  | 'phone_rate_limited'

/** Motifs d'indisponibilité du contrôle lui-même. */
export type AbuseUnavailableReason =
  'secret_missing' | 'challenge_unavailable' | 'storage_unavailable'

/** Décision rendue par le contrôle. Liste fermée, sans donnée personnelle. */
export type AbuseDecision =
  | { ok: true }
  | {
      ok: false
      outcome: 'refused'
      reason: AbuseRefusalReason
      code: 'invalid_request' | 'challenge_failed' | 'too_many_requests'
      /** Attente conseillée, quand la limitation de débit est en cause. */
      retryAfterSeconds?: number
    }
  | { ok: false; outcome: 'unavailable'; reason: AbuseUnavailableReason }

/** Adresse de vérification Turnstile. Constante : jamais fournie par un client. */
const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Délai maximal de la vérification du défi, en millisecondes. */
const TURNSTILE_TIMEOUT_MS = 10_000

/** Longueur minimale du secret de limitation : une empreinte non devinable. */
const MIN_SECRET_LENGTH = 32

/** Lit le secret de limitation, ou rend le motif d'indisponibilité. */
export function readRateLimitSecret(
  source: AbuseGuardEnvironmentSource,
): string | null {
  const secret = (source.RATE_LIMIT_SECRET ?? '').trim()
  return secret.length >= MIN_SECRET_LENGTH ? secret : null
}

/**
 * Vérifie le jeton Turnstile auprès de Cloudflare.
 *
 * Renvoie `true` si le défi est résolu. Un échec RÉSEAU n'est pas un échec du
 * visiteur : il rend `null`, que l'appelant traduit en indisponibilité (503) plutôt
 * qu'en refus — un formulaire ne doit pas accuser un visiteur de la panne d'un tiers.
 */
async function verifyTurnstile(input: {
  secret: string
  token: string
  clientIp: string | null
  fetchImplementation: typeof fetch
}): Promise<boolean | null> {
  try {
    const body = new URLSearchParams({
      // Le secret n'apparaît que dans ce corps POST, jamais dans l'URL.
      secret: input.secret,
      response: input.token,
    })
    if (input.clientIp !== null) {
      body.set('remoteip', input.clientIp)
    }

    const response = await input.fetchImplementation(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return null
    }
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null) {
      return null
    }
    return (payload as { success?: unknown }).success === true
  } catch {
    // Aucun message d'exception recopié : il peut contenir le jeton ou le secret.
    return null
  }
}

/** Empreinte d'une cible de limitation : type + valeur, jamais la valeur seule. */
function targetHash(
  secret: string,
  kind: string,
  value: string,
): Promise<string> {
  return hmacSha256Hex(secret, `${kind}:${value}`)
}

/**
 * Contrôle d'abus d'une soumission de formulaire.
 *
 * Ordre des décisions, du moins coûteux au plus précis : champ leurre, défi
 * Turnstile (s'il est configuré), puis limitation de débit. Une tentative est
 * enregistrée avant d'être comparée au plafond, ce qui rend le comptage fiable même
 * sous concurrence.
 */
export async function checkFormAbuse(input: {
  db: Db
  scope: RateLimitScope
  secret: string
  clientIp: string | null
  email: string
  phoneNormalized: string | null
  honeypot: string | null
  turnstileToken: string | null
  turnstileSecret?: string
  policy?: AbusePolicy
  now?: number
  fetchImplementation?: typeof fetch
}): Promise<AbuseDecision> {
  const now = input.now ?? nowSeconds()
  const policy = input.policy ?? DEFAULT_ABUSE_POLICY

  // 1. Champ leurre : rempli ⇒ soumission automatisée. La tentative est comptée
  //    malgré tout — un robot qui insiste s'arrête de lui-même — sous l'empreinte de
  //    l'adresse réseau quand elle est connue, et sous celle de l'adresse
  //    électronique dans tous les cas (elle est toujours renseignée, alors que
  //    l'en-tête réseau peut manquer : appel interne, proxy, test).
  if (isHoneypotFilled(input.honeypot)) {
    const keys: string[] = []
    if (input.clientIp !== null) {
      keys.push(await targetHash(input.secret, 'ip', input.clientIp))
    }
    if (input.email !== '') {
      keys.push(await targetHash(input.secret, 'email', input.email))
    }
    for (const keyHash of keys) {
      try {
        await recordRateLimitHit(input.db, { scope: input.scope, keyHash, now })
      } catch {
        // Un échec de comptage ne change pas la décision : le leurre a parlé.
      }
    }
    return {
      ok: false,
      outcome: 'refused',
      reason: 'honeypot',
      code: 'invalid_request',
    }
  }

  // 2. Défi Turnstile, seulement s'il est configuré côté serveur.
  const turnstileSecret = (input.turnstileSecret ?? '').trim()
  if (turnstileSecret !== '') {
    const token = (input.turnstileToken ?? '').trim()
    if (token === '') {
      return {
        ok: false,
        outcome: 'refused',
        reason: 'challenge_invalid',
        code: 'challenge_failed',
      }
    }
    const resolved = await verifyTurnstile({
      secret: turnstileSecret,
      token,
      clientIp: input.clientIp,
      fetchImplementation: input.fetchImplementation ?? fetch,
    })
    if (resolved === null) {
      return {
        ok: false,
        outcome: 'unavailable',
        reason: 'challenge_unavailable',
      }
    }
    if (!resolved) {
      return {
        ok: false,
        outcome: 'refused',
        reason: 'challenge_invalid',
        code: 'challenge_failed',
      }
    }
  }

  // 3. Limitation de débit par empreinte. Les trois cibles sont comptées.
  const windows: {
    reason: AbuseRefusalReason
    scopeKey: string
    value: string | null
    max: number
    windowSeconds: number
  }[] = [
    {
      reason: 'ip_rate_limited',
      scopeKey: 'ip',
      value: input.clientIp,
      max: policy.ipMax,
      windowSeconds: policy.ipWindowSeconds,
    },
    {
      // L'adresse électronique est obligatoire depuis la V1 : c'est le frein le
      // plus juste, une boîte ne pouvant pas être multipliée à l'infini.
      reason: 'email_rate_limited',
      scopeKey: 'email',
      value: input.email,
      max: policy.emailMax,
      windowSeconds: policy.emailWindowSeconds,
    },
    {
      reason: 'phone_rate_limited',
      scopeKey: 'phone',
      value: input.phoneNormalized,
      max: policy.phoneMax,
      windowSeconds: policy.phoneWindowSeconds,
    },
  ]

  try {
    const counted: {
      reason: AbuseRefusalReason
      keyHash: string
      max: number
      windowSeconds: number
    }[] = []

    for (const window of windows) {
      if (window.value === null || window.value === '') {
        continue
      }
      const keyHash = await targetHash(
        input.secret,
        window.scopeKey,
        window.value,
      )
      await recordRateLimitHit(input.db, { scope: input.scope, keyHash, now })
      counted.push({
        reason: window.reason,
        keyHash,
        max: window.max,
        windowSeconds: window.windowSeconds,
      })
    }

    for (const window of counted) {
      const total = await countRateLimitHits(input.db, {
        scope: input.scope,
        keyHash: window.keyHash,
        since: now - window.windowSeconds,
      })
      if (total > window.max) {
        // Attente conseillée : la fenêtre entière, valeur prudente mais jamais
        // fausse (aucune donnée sur la date exacte de la première tentative n'est
        // nécessaire pour la communiquer).
        return {
          ok: false,
          outcome: 'refused',
          reason: window.reason,
          code: 'too_many_requests',
          retryAfterSeconds: window.windowSeconds,
        }
      }
    }
  } catch {
    // Base indisponible : on refuse la soumission plutôt que de laisser passer une
    // rafale sans contrôle. Le client peut réessayer.
    return { ok: false, outcome: 'unavailable', reason: 'storage_unavailable' }
  }

  return { ok: true }
}
