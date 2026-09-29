/**
 * Contexte commun aux routes de l'API.
 *
 * `Env` est généré par `wrangler types` à partir de wrangler.jsonc : il contient
 * donc les BINDINGS (`ASSETS`, `DB`) et, le cas échéant, les variables non
 * sensibles déclarées dans la section `vars`.
 *
 * Deux familles de valeurs n'y figurent pas, et ne peuvent pas y figurer :
 *
 *   * les SECRETS (`RATE_LIMIT_SECRET`, `TURNSTILE_SECRET`, `RESEND_API_KEY`) :
 *     wrangler.jsonc est versionné, donc aucun secret ne peut y être déclaré. Ils
 *     sont fournis au Worker par `.dev.vars` en local (fichier ignoré par Git) et par
 *     `wrangler secret put <NOM>` en ligne ;
 *   * les RÉGLAGES optionnels (taille de lot d'envoi, plafonds, secret Turnstile),
 *     dont l'absence doit conserver les valeurs par défaut sûres du code.
 *
 * `WorkerVariables` décrit ces valeurs pour que `c.env` reste vérifié à la
 * compilation. Toutes sont OPTIONNELLES à dessein : c'est le code — jamais le type —
 * qui décide de ce qui est obligatoire, et qui échoue avec un code public fermé
 * lorsqu'une valeur requise manque (jamais par une exception de type).
 *
 * Les deux ensembles sont importés des modules qui les LISENT : un nom de variable
 * ajouté d'un côté ne peut donc pas être oublié de l'autre.
 */

import type { EmailProviderEnvironmentSource } from './providers/email-provider'
import type { AbuseGuardEnvironmentSource } from './services/abuse-guard'
import type { EmailDispatchEnvironmentSource } from './services/email-dispatch'
import type { NotificationEnvironmentSource } from './services/notifications'

/**
 * Valeurs d'environnement du Worker absentes des types générés.
 *
 * S'y ajoute le BINDING d'envoi d'e-mails (`EMAIL`), absent de `Env` tant qu'il n'est
 * pas déclaré dans `wrangler.jsonc` — le type structurel permet d'écrire le
 * fournisseur, et la sélection le refuse proprement s'il manque.
 */
export type WorkerVariables = NotificationEnvironmentSource &
  EmailProviderEnvironmentSource &
  EmailDispatchEnvironmentSource &
  AbuseGuardEnvironmentSource & {
    /** development | staging | production. Jamais recopié dans une réponse. */
    ENVIRONMENT?: string
  }

/** Environnement Hono : bindings réels + secrets et réglages d'exécution. */
export type AppEnv = {
  Bindings: Env & WorkerVariables
}
