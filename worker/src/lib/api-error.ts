import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** Corps JSON renvoyé par l'API en cas d'erreur. */
export type ApiErrorBody = {
  error: {
    /** Code stable : le front s'appuie dessus, jamais sur le message. */
    code: string
    /** Message lisible, destiné aux journaux et au développeur. */
    message: string
  }
}

/**
 * Réponse d'erreur unique de l'API.
 *
 * Elle garantit qu'une route d'API renvoie toujours du JSON (et jamais la page
 * HTML du front), y compris pour les erreurs inattendues.
 */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  const body: ApiErrorBody = { error: { code, message } }
  return c.json(body, status)
}
