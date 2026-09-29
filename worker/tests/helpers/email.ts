/**
 * Outils de test de l'envoi des notifications.
 *
 * Deux doubles, et rien d'autre : un fournisseur qui enregistre ce qu'il reçoit et
 * suit un scénario de réponses, et un journal qui collecte les entrées en mémoire.
 * Aucun accès réseau, aucun envoi réel — c'est la condition pour que ces tests
 * puissent tourner partout, y compris sans configuration.
 */

import type {
  EmailProvider,
  EmailSendResult,
} from '../../src/providers/messaging'
import type { OutboundEmail } from '../../src/providers/messaging'
import type {
  EmailDispatchLogEntry,
  EmailDispatchLogger,
} from '../../src/services/email-dispatch'

export type EmailProviderSpy = {
  provider: EmailProvider
  /** Courriels réellement transmis, dans l'ordre. */
  sent: OutboundEmail[]
}

/**
 * Scénario de réponses : la dernière est répétée si le fournisseur est appelé plus
 * de fois que prévu. `delayMs` sert à provoquer un chevauchement de deux passages.
 */
export function createEmailProviderSpy(script: {
  results: EmailSendResult[]
  delayMs?: number
}): EmailProviderSpy {
  const sent: OutboundEmail[] = []
  let index = 0
  const provider: EmailProvider = {
    async send(email) {
      sent.push(email)
      if (script.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, script.delayMs))
      }
      const result = script.results[
        Math.min(index, script.results.length - 1)
      ] ??
        script.results[0] ?? {
          accepted: false,
          errorCode: 'provider_unavailable',
        }
      index += 1
      return result
    },
  }
  return { provider, sent }
}

/** Journal collecté en mémoire, comme pour les autres services. */
export function createEmailLogSpy(): {
  entries: EmailDispatchLogEntry[]
  log: EmailDispatchLogger
} {
  const entries: EmailDispatchLogEntry[] = []
  return { entries, log: (entry) => entries.push(entry) }
}
