/**
 * Traitement périodique : c'est lui qui fait vivre la file des notifications.
 *
 * Le Worker reçoit une invocation planifiée (voir `triggers.crons` dans
 * `wrangler.jsonc`), qui déclenche ici un passage unique sur la file. Ce module ne
 * contient AUCUNE logique d'envoi : il assemble trois choses et délègue.
 *
 *   * le FOURNISSEUR, lu depuis l'environnement (`EMAIL_PROVIDER`, adresse
 *     d'expédition, clé ou binding) : une configuration incomplète annule le
 *     passage — la file n'est pas touchée, donc rien n'est perdu ni compté ;
 *   * la POLITIQUE d'envoi (`EMAIL_MAX_ATTEMPTS`, `EMAIL_DISPATCH_BATCH_SIZE`) ;
 *   * le SERVICE de traitement (`services/email-dispatch.ts`).
 *
 * Deux ajouts d'exploitation, tous deux sans effet sur les données clientes :
 *   * chaque passage écrit une ligne de bilan (JSON, sans donnée personnelle) ;
 *   * la PURGE de conservation s'exécute au même moment : une notification acceptée
 *     depuis assez longtemps est effacée, emportant l'adresse du destinataire et le
 *     texte du message. C'est ce qui rend vraie la promesse de ne pas garder
 *     indéfiniment des données personnelles dans une file technique.
 *
 * Ce module n'est jamais appelé par une route HTTP : aucun client ne peut déclencher
 * un envoi. Seul le planificateur de Cloudflare le peut.
 */

import { nowSeconds } from './db/client'
import { purgeEmailOutbox } from './db/repositories/email-outbox'
import {
  EmailConfigurationError,
  readEmailSender,
} from './providers/email-provider'
import type { EmailProvider } from './providers/messaging'
import {
  EmailDispatchConfigurationError,
  dispatchPendingEmails,
  emailDispatchConsoleLogger,
  readEmailDispatchPolicy,
} from './services/email-dispatch'
import type {
  EmailDispatchLogger,
  EmailDispatchPolicy,
  EmailDispatchSummary,
} from './services/email-dispatch'
import type { AppEnv } from './types'

/**
 * Durée de conservation d'une notification acceptée, en secondes.
 *
 * Trente jours : largement de quoi enquêter après coup (retrouver une demande
 * signalée comme non reçue), et assez court pour que la file ne devienne pas un
 * journal de données personnelles. La purge ne touche jamais une entrée qui n'a pas
 * été acceptée par le fournisseur.
 */
export const SENT_NOTIFICATION_RETENTION_SECONDS = 30 * 24 * 60 * 60

/**
 * Ligne de bilan d'un passage.
 *
 * Le succès est consigné sans donnée personnelle : uniquement des compteurs et le
 * motif d'un éventuel arrêt anticipé.
 */
export type ScheduledLogEntry = {
  event: 'email.dispatch'
  outcome: 'pass_done' | 'pass_skipped'
  /** Motif d'arrêt, quand le passage n'a pas tourné : code fermé. */
  reason?: string
  /** Expression de planification reçue, telle que fournie par Cloudflare. */
  cron?: string
  summary?: EmailDispatchSummary
  /** Entrées purgées à l'issue du passage. */
  purged?: number
}

function formatScheduledLogEntry(entry: ScheduledLogEntry): string {
  return `[email] ${JSON.stringify(entry)}`
}

/** Motif technique d'un arrêt, jamais le message d'une exception. */
function reasonOf(error: unknown): string {
  if (
    error instanceof EmailConfigurationError ||
    error instanceof EmailDispatchConfigurationError
  ) {
    return error.code
  }
  return 'unexpected'
}

/** Dépendances injectables : les tests n'ont besoin ni d'environnement ni de réseau. */
export type ScheduledDependencies = {
  /** Fournisseur déjà construit (tests). Sinon, lu depuis l'environnement. */
  provider?: EmailProvider
  /** Politique d'envoi (tests). Sinon, lue depuis l'environnement. */
  policy?: EmailDispatchPolicy
  /** Horloge en secondes Unix (tests) : `nowSeconds` par défaut. */
  now?: () => number
  /** Journal du service de traitement (tests). */
  log?: EmailDispatchLogger
}

/**
 * Construit le traitement planifié du Worker.
 *
 * Signature imposée par le runtime : `(controller, env, ctx)`. Le contexte
 * d'exécution n'est pas utilisé : tout est attendu avant le retour, parce qu'un
 * traitement qui se contenterait de « lancer » ses envois pourrait être interrompu
 * au milieu d'une prise sous bail.
 */
export function createScheduledHandler(
  dependencies: ScheduledDependencies = {},
): (controller: ScheduledController, env: AppEnv['Bindings']) => Promise<void> {
  const log = dependencies.log ?? emailDispatchConsoleLogger

  return async function handleScheduled(
    controller: ScheduledController,
    env: AppEnv['Bindings'],
  ): Promise<void> {
    const now = dependencies.now?.() ?? nowSeconds()

    // Fournisseur : sans configuration complète, le passage est annulé AVANT toute
    // écriture. Les entrées restent en attente, intactes, et le motif est consigné.
    let provider = dependencies.provider
    if (provider === undefined) {
      try {
        provider = readEmailSender(env).provider
      } catch (error) {
        console.error(
          formatScheduledLogEntry({
            event: 'email.dispatch',
            outcome: 'pass_skipped',
            reason: reasonOf(error),
            cron: controller.cron,
          }),
        )
        return
      }
    }

    let policy = dependencies.policy
    if (policy === undefined) {
      try {
        policy = readEmailDispatchPolicy(env)
      } catch (error) {
        console.error(
          formatScheduledLogEntry({
            event: 'email.dispatch',
            outcome: 'pass_skipped',
            reason: reasonOf(error),
            cron: controller.cron,
          }),
        )
        return
      }
    }

    let summary: EmailDispatchSummary
    try {
      summary = await dispatchPendingEmails({
        db: env.DB,
        provider,
        policy,
        now,
        log,
      })
    } catch (error) {
      // Cause imprévue : le service traite déjà les cas connus. On le dit, sans
      // recopier le message de l'exception (il peut contenir du SQL ou une valeur).
      console.error(
        formatScheduledLogEntry({
          event: 'email.dispatch',
          outcome: 'pass_skipped',
          reason: reasonOf(error),
          cron: controller.cron,
        }),
      )
      return
    }

    let purged = 0
    try {
      purged = await purgeEmailOutbox(env.DB, {
        sentBefore: now - SENT_NOTIFICATION_RETENTION_SECONDS,
      })
    } catch {
      // La purge est un nettoyage : son échec ne remet pas en cause les envois.
      // Elle sera retentée au passage suivant, et reste bornée par lot.
      purged = 0
    }

    console.log(
      formatScheduledLogEntry({
        event: 'email.dispatch',
        outcome: 'pass_done',
        cron: controller.cron,
        summary,
        purged,
      }),
    )
  }
}
