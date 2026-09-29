import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** Corps JSON renvoyé par l'API en cas d'erreur. */
export type ApiErrorBody = {
  error: {
    /** Code stable : le front s'appuie dessus, jamais sur le message. */
    code: string
    /** Message lisible, destiné aux journaux et au développeur. */
    message: string
    /**
     * Attente conseillée avant un nouvel essai, en secondes.
     *
     * Présent uniquement quand le service en connaît une (limitation d'abus,
     * refus temporaire du fournisseur). Il accompagne l'en-tête `Retry-After`,
     * que les intermédiaires réseau lisent sans déplier le corps.
     */
    retryAfterSeconds?: number
  }
}

/**
 * Réponse d'erreur unique de l'API.
 *
 * Elle garantit qu'une route d'API renvoie toujours du JSON (et jamais la page
 * HTML du front), y compris pour les erreurs inattendues.
 *
 * `retryAfterSeconds` n'est repris que s'il s'agit d'un entier positif : une
 * valeur fabriquée par un appelant ne doit pas pouvoir produire un en-tête
 * `Retry-After` absurde (négatif, décimal, `NaN`).
 */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  retryAfterSeconds?: number,
) {
  const retry =
    retryAfterSeconds !== undefined &&
    Number.isSafeInteger(retryAfterSeconds) &&
    retryAfterSeconds > 0
      ? retryAfterSeconds
      : undefined

  const body: ApiErrorBody =
    retry === undefined
      ? { error: { code, message } }
      : { error: { code, message, retryAfterSeconds: retry } }

  return retry === undefined
    ? c.json(body, status)
    : c.json(body, status, { 'Retry-After': String(retry) })
}
