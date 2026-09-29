/**
 * Traitement de la file des notifications : lecture des entrées dues, envoi réel,
 * marquage du résultat.
 *
 * C'est le seul endroit du projet qui ENVOIE des courriels, et il ne décide ni de
 * leur contenu (c'est `services/notifications.ts`, au moment de la demande) ni de
 * leur transport (c'est le fournisseur, `providers/email-provider.ts`). Son travail
 * tient en cinq règles :
 *
 *   1. PRISE SOUS BAIL avant tout envoi. Deux traitements ne peuvent pas envoyer le
 *      même courriel en même temps : la base tranche (`claimEmailOutboxEntry`).
 *   2. UN ESSAI COMPTÉ par appel réel au fournisseur, et jamais deux fois.
 *   3. ÉCHEC TEMPORAIRE ≠ ÉCHEC DÉFINITIF. Une panne du fournisseur repousse
 *      l'essai (nouvel essai programmé, avec le délai annoncé par le fournisseur
 *      lorsqu'il en donne un) ; au plafond, l'entrée est abandonnée en `failed` —
 *      visible, et non supprimée en silence.
 *   4. AUCUNE DONNÉE PERSONNELLE DANS LES JOURNAUX. Ni destinataire, ni sujet, ni
 *      corps : seulement l'identifiant de la file, le nombre d'essais, un code
 *      technique fermé et, éventuellement, l'identifiant opaque du fournisseur.
 *   5. UNE LIGNE « SENT » N'EST PAS UN COURRIEL REMIS. Elle atteste que le
 *      fournisseur a accepté le message. La remise relève du fournisseur.
 *
 * Le service est appelé par le traitement périodique (`src/scheduled.ts`) ; il ne
 * fait aucun accès réseau en dehors du port `EmailProvider`, injectable par les
 * tests.
 */

import { clampLimit, nowSeconds } from '../db/client'
import type { Db } from '../db/client'
import type { DbFailureCode } from '../db/errors'
import { toDbError } from '../db/errors'
import {
  DEFAULT_LEASE_SECONDS,
  claimEmailOutboxEntry,
  listDueEmailOutbox,
  markEmailOutboxFailed,
  markEmailOutboxSent,
} from '../db/repositories/email-outbox'
import type { EmailOutboxRow } from '../db/repositories/email-outbox'
import type { EmailProvider, EmailSendResult } from '../providers/messaging'

/** Politique d'envoi : combien de tentatives, combien d'entrées par passage. */
export type EmailDispatchPolicy = {
  maxAttempts: number
  batchSize: number
}

/** Valeurs par défaut, appliquées quand rien n'est configuré. */
export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_BATCH_SIZE = 10
/** Plafond de tentatives du schéma : la politique ne peut pas le dépasser. */
export const MAX_ATTEMPTS_CEILING = 20
/** Taille de lot maximale acceptée, pour borner la durée d'un passage. */
export const MAX_BATCH_SIZE = 50

/** Variables d'environnement lues par ce module (noms, jamais de valeur). */
export type EmailDispatchEnvironmentSource = {
  EMAIL_MAX_ATTEMPTS?: string
  EMAIL_DISPATCH_BATCH_SIZE?: string
}

/** Codes d'erreur de configuration. Liste fermée. */
export type EmailDispatchConfigurationErrorCode =
  'email_max_attempts_invalid' | 'email_batch_size_invalid'

const CONFIGURATION_MESSAGES: Record<
  EmailDispatchConfigurationErrorCode,
  string
> = {
  email_max_attempts_invalid:
    "Le nombre maximal de tentatives d'envoi est mal formé.",
  email_batch_size_invalid: "La taille du lot d'envoi est mal formée.",
}

/**
 * Erreur de configuration du traitement de la file.
 *
 * Comme ailleurs, le message ne recopie jamais la valeur fournie : seul le NOM de
 * la variable fautive est ajouté.
 */
export class EmailDispatchConfigurationError extends Error {
  readonly code: EmailDispatchConfigurationErrorCode
  readonly field: string

  constructor(code: EmailDispatchConfigurationErrorCode, field: string) {
    super(`${CONFIGURATION_MESSAGES[code]} (${field})`)
    this.name = 'EmailDispatchConfigurationError'
    this.code = code
    this.field = field
  }
}

/** Lit un entier positif borné, ou refuse la configuration. */
function readPositiveInteger(
  value: string | undefined,
  field: string,
  maximum: number,
  code: EmailDispatchConfigurationErrorCode,
): number | undefined {
  const raw = (value ?? '').trim()
  if (raw === '') {
    return undefined
  }
  if (!/^[0-9]{1,4}$/.test(raw)) {
    throw new EmailDispatchConfigurationError(code, field)
  }
  const parsed = Number(raw)
  if (parsed < 1 || parsed > maximum) {
    throw new EmailDispatchConfigurationError(code, field)
  }
  return parsed
}

/**
 * Lit la politique d'envoi, en gardant les valeurs par défaut pour ce qui n'est pas
 * configuré.
 *
 * Une valeur mal formée est REFUSÉE plutôt que corrigée en silence : une variable
 * d'environnement qu'on croit appliquée mais qui ne l'est pas est un piège — on
 * croirait la file plus prudente qu'elle ne l'est.
 */
export function readEmailDispatchPolicy(
  source: EmailDispatchEnvironmentSource = {},
): EmailDispatchPolicy {
  return {
    maxAttempts:
      readPositiveInteger(
        source.EMAIL_MAX_ATTEMPTS,
        'EMAIL_MAX_ATTEMPTS',
        MAX_ATTEMPTS_CEILING,
        'email_max_attempts_invalid',
      ) ?? DEFAULT_MAX_ATTEMPTS,
    batchSize:
      readPositiveInteger(
        source.EMAIL_DISPATCH_BATCH_SIZE,
        'EMAIL_DISPATCH_BATCH_SIZE',
        MAX_BATCH_SIZE,
        'email_batch_size_invalid',
      ) ?? DEFAULT_BATCH_SIZE,
  }
}

/**
 * Attente entre deux essais, en secondes, indexée par le numéro d'essai.
 *
 * Progression volontairement lente à partir de la deuxième tentative : une panne
 * de fournisseur dure rarement quelques secondes, et une boîte de réception n'a
 * pas à recevoir dix fois la même relance. Le dernier palier est répété tant que
 * des essais restent.
 */
export const RETRY_SCHEDULE_SECONDS: readonly number[] = [
  60, 300, 900, 3600, 7200,
]

/** Délai avant le prochain essai d'une entrée qui vient échouer. */
export function retryDelaySeconds(attempt: number): number {
  const index =
    Math.min(Math.max(attempt, 1), RETRY_SCHEDULE_SECONDS.length) - 1
  return RETRY_SCHEDULE_SECONDS[index] ?? 60
}

/**
 * Causes internes d'une décision d'envoi. Elles restent dans les journaux.
 */
export type EmailDispatchLogReason =
  | 'sent'
  | 'retry_scheduled'
  | 'abandoned'
  | 'claim_lost'
  | 'record_lost'
  | 'storage_unavailable'

/**
 * Entrée d'un journal d'envoi.
 *
 * Ce type est la garantie « aucune donnée personnelle dans les journaux » : il ne
 * peut porter ni destinataire, ni sujet, ni corps, ni message d'erreur brut. Il ne
 * connaît que l'identifiant de la file, le nombre d'essais, un code technique fermé
 * et l'identifiant opaque du fournisseur.
 */
export type EmailDispatchLogEntry = {
  event: 'email.dispatch'
  outcome: 'sent' | 'retried' | 'abandoned' | 'skipped' | 'failed'
  reason: EmailDispatchLogReason
  /** Identifiant de la file ; absent si l'échec précède toute lecture de ligne. */
  emailId?: number
  attempts?: number
  errorCode?: string
  providerMessageId?: string
  dbCode?: DbFailureCode
}

/** Journaliseur injectable : les tests collectent les entrées sans I/O. */
export type EmailDispatchLogger = (entry: EmailDispatchLogEntry) => void

/** Sérialisation d'une entrée en une ligne unique, sans donnée personnelle. */
export function formatEmailDispatchLogEntry(
  entry: EmailDispatchLogEntry,
): string {
  return `[email] ${JSON.stringify(entry)}`
}

/** Journaliseur par défaut (Cloudflare collecte la sortie standard). */
export const emailDispatchConsoleLogger: EmailDispatchLogger = (entry) => {
  console.log(formatEmailDispatchLogEntry(entry))
}

/** Bilan d'un passage, destiné au journal du traitement périodique. */
export type EmailDispatchSummary = {
  /** Entrées examinées (candidates lues en base). */
  examined: number
  /** Entrées réellement prises sous bail, donc tentées. */
  claimed: number
  /** Entrées acceptées par le fournisseur et marquées « envoyées ». */
  sent: number
  /** Échecs temporaires : un nouvel essai est programmé. */
  retried: number
  /** Échecs définitifs : le plafond de tentatives est atteint. */
  abandoned: number
  /** Entrées ni envoyées ni marquées : prise perdue, ou marquage impossible. */
  lost: number
}

/** Codes techniques acceptés dans un journal : liste blanche. */
const PROVIDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/

/** Identifiant de message : caractères techniques, longueur bornée. */
const PROVIDER_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:=+/-]{1,200}$/

/**
 * Nettoie un code d'erreur de fournisseur avant écriture ou journalisation.
 *
 * Un fournisseur — ou un double de test mal écrit — pourrait renvoyer un message
 * complet dans ce champ, y compris l'adresse du destinataire. Seule une forme
 * technique courte est conservée ; tout le reste devient `provider_error`.
 */
function sanitizeProviderCode(errorCode: string | undefined): string {
  if (errorCode === undefined) {
    return 'provider_error'
  }
  const normalized = errorCode.trim().toLowerCase()
  return PROVIDER_CODE_PATTERN.test(normalized) ? normalized : 'provider_error'
}

/** Identifiant de fournisseur journalisable, ou rien du tout. */
function sanitizeProviderMessageId(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const trimmed = value.trim()
  return PROVIDER_MESSAGE_ID_PATTERN.test(trimmed) ? trimmed : undefined
}

/**
 * Délai avant nouvel essai : celui annoncé par le fournisseur s'il est exploitable,
 * la progression du projet sinon.
 *
 * Un `Retry-After` n'est retenu que s'il tient dans une heure : au-delà, il vaut
 * mieux rappeler la file à son propre rythme que de la laisser dormir sur une
 * valeur aberrante.
 */
function retryDelayFor(
  providerRetryAfterSeconds: number | undefined,
  attempt: number,
): number {
  if (
    providerRetryAfterSeconds !== undefined &&
    Number.isInteger(providerRetryAfterSeconds) &&
    providerRetryAfterSeconds >= 1 &&
    providerRetryAfterSeconds <= 3600
  ) {
    return providerRetryAfterSeconds
  }
  return retryDelaySeconds(attempt)
}

/**
 * Appelle le fournisseur sans laisser sortir d'exception.
 *
 * Un fournisseur ne devrait jamais lever : il renvoie un résultat. S'il le fait,
 * c'est un échec d'envoi de plus — jamais une panne du traitement, et jamais un
 * message d'exception recopié (il peut contenir le contenu du courriel).
 */
async function sendSafely(
  provider: EmailProvider,
  entry: EmailOutboxRow,
): Promise<EmailSendResult> {
  try {
    return await provider.send({
      to: entry.recipient,
      subject: entry.subject,
      bodyText: entry.body_text,
    })
  } catch {
    return { accepted: false, errorCode: 'provider_exception' }
  }
}

/**
 * Issue d'une tentative d'envoi pour UNE entrée : des faits, rien d'autre.
 *
 * `claimed` dit si l'entrée a réellement été prise sous bail. Le reste décrit ce qui
 * s'en est suivi, dans une liste fermée :
 *
 *   * `sent` : le fournisseur a accepté le message, et la file l'a inscrit ;
 *   * `retried` : refus temporaire, un nouvel essai est programmé ;
 *   * `abandoned` : plafond de tentatives atteint, l'entrée n'est plus proposée ;
 *   * `not_recorded` : le fournisseur a peut-être accepté (ou pas), mais la file n'a
 *     pas pu l'inscrire — le seul cas où l'état réel est incertain, et le seul qui
 *     mérite un coup d'œil humain ;
 *   * `not_claimable` : rien n'a été envoyé, l'entrée n'était pas due ou un autre
 *     traitement l'avait prise ;
 *   * `storage_unavailable` : la base n'a pas répondu, rien ne peut être affirmé.
 */
export type EmailDispatchOutcome =
  | {
      claimed: true
      status: 'sent'
      emailId: number
      /** Nombre d'essais réels inscrits, mise à jour par le marquage. */
      attempts: number
      providerMessageId?: string
    }
  | {
      claimed: true
      status: 'retried' | 'abandoned'
      emailId: number
      attempts: number
      errorCode: string
    }
  | {
      claimed: true
      status: 'not_recorded'
      emailId: number
      attempts: number
      errorCode?: string
      providerMessageId?: string
    }
  | { claimed: false; status: 'not_claimable'; emailId: number }
  | { claimed: false; status: 'storage_unavailable'; emailId: number }

/**
 * Traite UNE entrée désignée par son identifiant : prise sous bail, envoi, marquage.
 *
 * C'est le seul chemin d'envoi du projet — `dispatchPendingEmails` l'appelle en
 * boucle. Il existe aussi pour lui-même : un outil d'exploitation doit pouvoir
 * envoyer UNE notification précise sans risquer d'expédier tout ce qui attend dans
 * la file. C'est ce que fait le test manuel d'envoi réel, qui ne désigne jamais
 * qu'une seule entrée.
 *
 * La fonction ne lève pas pour une cause prévisible : une panne de base ou un refus
 * du fournisseur sont journalisés ET rendus en clair, parce qu'un traitement
 * silencieux est pire qu'un échec annoncé.
 */
export async function dispatchOneEmail(input: {
  db: Db
  provider: EmailProvider
  emailId: number
  maxAttempts?: number
  leaseSeconds?: number
  now?: number
  log?: EmailDispatchLogger
}): Promise<EmailDispatchOutcome> {
  const now = input.now ?? nowSeconds()
  const maxAttempts = clampLimit(
    input.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    MAX_ATTEMPTS_CEILING,
  )
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  const log = input.log ?? emailDispatchConsoleLogger
  const emailId = input.emailId

  let claimed: EmailOutboxRow | null
  try {
    claimed = await claimEmailOutboxEntry(input.db, {
      emailId,
      now,
      maxAttempts,
      leaseSeconds,
    })
  } catch (error) {
    log({
      event: 'email.dispatch',
      outcome: 'failed',
      reason: 'storage_unavailable',
      emailId,
      dbCode: toDbError(error).code,
    })
    return { claimed: false, status: 'storage_unavailable', emailId }
  }

  if (claimed === null) {
    // Entrée non due (déjà envoyée, reportée, abandonnée) ou prise par un autre
    // traitement : ne rien envoyer est exactement le comportement voulu.
    log({
      event: 'email.dispatch',
      outcome: 'skipped',
      reason: 'claim_lost',
      emailId,
    })
    return { claimed: false, status: 'not_claimable', emailId }
  }

  const result = await sendSafely(input.provider, claimed)
  return result.accepted
    ? recordSent(input.db, claimed, result, now, log)
    : recordFailure(input.db, claimed, result, maxAttempts, now, log)
}

/** Enregistre une acceptation du fournisseur, ou son impossibilité à l'inscrire. */
async function recordSent(
  db: Db,
  entry: EmailOutboxRow,
  result: EmailSendResult,
  now: number,
  log: EmailDispatchLogger,
): Promise<EmailDispatchOutcome> {
  const providerMessageId = sanitizeProviderMessageId(result.providerMessageId)
  try {
    const sent = await markEmailOutboxSent(db, { emailId: entry.id, now })
    if (sent === null) {
      // Le fournisseur a accepté le message, mais la file ne peut plus l'inscrire
      // (entrée annulée, ou plafond atteint entre-temps). Le courriel est parti :
      // le journal le dit honnêtement, et l'issue restera « non inscrit » — c'est
      // le seul cas où l'état réel demande un coup d'œil humain.
      log({
        event: 'email.dispatch',
        outcome: 'skipped',
        reason: 'record_lost',
        emailId: entry.id,
        attempts: entry.attempts,
        ...(providerMessageId === undefined ? {} : { providerMessageId }),
      })
      return {
        claimed: true,
        status: 'not_recorded',
        emailId: entry.id,
        attempts: entry.attempts,
        ...(providerMessageId === undefined ? {} : { providerMessageId }),
      }
    }
    log({
      event: 'email.dispatch',
      outcome: 'sent',
      reason: 'sent',
      emailId: sent.id,
      attempts: sent.attempts,
      ...(providerMessageId === undefined ? {} : { providerMessageId }),
    })
    return {
      claimed: true,
      status: 'sent',
      emailId: sent.id,
      attempts: sent.attempts,
      ...(providerMessageId === undefined ? {} : { providerMessageId }),
    }
  } catch (error) {
    log({
      event: 'email.dispatch',
      outcome: 'failed',
      reason: 'storage_unavailable',
      emailId: entry.id,
      dbCode: toDbError(error).code,
    })
    return {
      claimed: true,
      status: 'not_recorded',
      emailId: entry.id,
      attempts: entry.attempts,
      ...(providerMessageId === undefined ? {} : { providerMessageId }),
    }
  }
}

/** Enregistre un échec d'envoi et programme la suite. */
async function recordFailure(
  db: Db,
  entry: EmailOutboxRow,
  result: EmailSendResult,
  maxAttempts: number,
  now: number,
  log: EmailDispatchLogger,
): Promise<EmailDispatchOutcome> {
  const errorCode = sanitizeProviderCode(result.errorCode)
  const retryAfterSeconds = retryDelayFor(
    result.retryAfterSeconds,
    entry.attempts,
  )
  try {
    const failed = await markEmailOutboxFailed(db, {
      emailId: entry.id,
      errorCode,
      retryAfterSeconds,
      maxAttempts,
      now,
    })
    if (failed === null) {
      // L'entrée n'était plus dans l'état attendu : l'échec ne peut pas être inscrit.
      log({
        event: 'email.dispatch',
        outcome: 'skipped',
        reason: 'record_lost',
        emailId: entry.id,
        attempts: entry.attempts,
        errorCode,
      })
      return {
        claimed: true,
        status: 'not_recorded',
        emailId: entry.id,
        attempts: entry.attempts,
        errorCode,
      }
    }
    if (failed.status === 'failed') {
      log({
        event: 'email.dispatch',
        outcome: 'abandoned',
        reason: 'abandoned',
        emailId: failed.id,
        attempts: failed.attempts,
        errorCode,
      })
      return {
        claimed: true,
        status: 'abandoned',
        emailId: failed.id,
        attempts: failed.attempts,
        errorCode,
      }
    }
    log({
      event: 'email.dispatch',
      outcome: 'retried',
      reason: 'retry_scheduled',
      emailId: failed.id,
      attempts: failed.attempts,
      errorCode,
    })
    return {
      claimed: true,
      status: 'retried',
      emailId: failed.id,
      attempts: failed.attempts,
      errorCode,
    }
  } catch (error) {
    log({
      event: 'email.dispatch',
      outcome: 'failed',
      reason: 'storage_unavailable',
      emailId: entry.id,
      dbCode: toDbError(error).code,
    })
    return {
      claimed: true,
      status: 'not_recorded',
      emailId: entry.id,
      attempts: entry.attempts,
      errorCode,
    }
  }
}

/**
 * Traite les notifications dues : une entrée, une prise sous bail, un envoi.
 *
 * La fonction ne lève pas pour une cause prévisible : une panne de base ou un refus
 * du fournisseur sont journalisés et comptés, parce qu'un traitement périodique qui
 * échoue en boucle sans rien dire est pire qu'un passage partiel annoncé.
 */
export async function dispatchPendingEmails(input: {
  db: Db
  provider: EmailProvider
  policy?: EmailDispatchPolicy
  leaseSeconds?: number
  now?: number
  log?: EmailDispatchLogger
}): Promise<EmailDispatchSummary> {
  const now = input.now ?? nowSeconds()
  const policy = input.policy ?? {
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    batchSize: DEFAULT_BATCH_SIZE,
  }
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  const log = input.log ?? emailDispatchConsoleLogger
  const summary: EmailDispatchSummary = {
    examined: 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    abandoned: 0,
    lost: 0,
  }

  let candidates: EmailOutboxRow[]
  try {
    candidates = await listDueEmailOutbox(input.db, {
      now,
      maxAttempts: policy.maxAttempts,
      limit: policy.batchSize,
    })
  } catch (error) {
    log({
      event: 'email.dispatch',
      outcome: 'failed',
      reason: 'storage_unavailable',
      dbCode: toDbError(error).code,
    })
    return summary
  }
  summary.examined = candidates.length

  for (const candidate of candidates) {
    // Un seul chemin d'envoi, quelle que soit la porte d'entrée : ici, une entrée
    // parmi les candidates ; dans le test manuel, une entrée désignée par référence.
    const outcome = await dispatchOneEmail({
      db: input.db,
      provider: input.provider,
      emailId: candidate.id,
      maxAttempts: policy.maxAttempts,
      leaseSeconds,
      now,
      log,
    })

    if (outcome.claimed) {
      summary.claimed += 1
    }
    switch (outcome.status) {
      case 'sent':
        summary.sent += 1
        break
      case 'retried':
        summary.retried += 1
        break
      case 'abandoned':
        summary.abandoned += 1
        break
      case 'not_recorded':
      case 'not_claimable':
      case 'storage_unavailable':
        summary.lost += 1
        break
    }
  }

  return summary
}
