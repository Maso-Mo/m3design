/**
 * Soumission d'un message de contact.
 *
 * Même parcours que la demande de devis, à deux différences près : le texte attendu
 * s'appelle `message`, et la référence publique commence par « MSG ». Le reste est
 * identique, et volontairement ainsi : validation par `services/request-fields.ts`,
 * anti-abus par `services/abuse-guard.ts`, idempotence, et écriture du message, de
 * son événement et de la notification dans le MÊME lot (tout ou rien).
 *
 * Aucune vérification de numéro n'intervient : le téléphone est facultatif et n'est
 * jamais présenté comme vérifié.
 */

import { nowSeconds } from '../db/client'
import type { Db } from '../db/client'
import type { DbFailureCode } from '../db/errors'
import { toDbError } from '../db/errors'
import {
  createContactMessage,
  findContactMessageByIdempotencyKey,
} from '../db/repositories/contact-messages'
import type { ContactMessageStatus } from '../db/repositories/contact-messages'
import { checkFormAbuse } from './abuse-guard'
import type { AbusePolicy } from './abuse-guard'
import { buildContactNotification } from './notifications'
import { maskPhoneNumber } from './phone'
import { generateContactReference } from './contact-reference'
import { hasUsableTextLength, validateIntakeFields } from './request-fields'
import type { IntakeFieldRefusal } from './request-fields'

/** Codes publics d'échec. Liste fermée. */
export type ContactSubmissionFailureCode =
  | 'invalid_request'
  | 'too_many_requests'
  | 'challenge_failed'
  | 'service_unavailable'

/** Causes internes d'une décision. Elles restent dans les journaux. */
export type ContactLogReason =
  | 'accepted'
  | 'replayed'
  | 'invalid_name'
  | 'invalid_email'
  | 'invalid_message'
  | 'invalid_phone'
  | 'invalid_idempotency_key'
  | 'abuse_honeypot'
  | 'abuse_challenge'
  | 'abuse_rate_limited'
  | 'abuse_unavailable'
  | 'reference_conflict'
  | 'storage_unavailable'
  | 'notification_unavailable'

/** Entrée d'un journal de soumission, sans aucune donnée personnelle. */
export type ContactLogEntry = {
  event: 'contact.submit'
  outcome: 'accepted' | 'refused' | 'failed'
  reason: ContactLogReason
  phoneMasked?: string
  messageReference?: string
  dbCode?: DbFailureCode
  attempt?: number
}

/** Journaliseur injectable : les tests collectent les entrées sans I/O. */
export type ContactRequestLogger = (entry: ContactLogEntry) => void

/** Sérialisation d'une entrée en une ligne unique. */
export function formatContactLogEntry(entry: ContactLogEntry): string {
  return `[contact] ${JSON.stringify(entry)}`
}

/** Journaliseur par défaut (Cloudflare collecte la sortie standard). */
export const contactConsoleLogger: ContactRequestLogger = (entry) => {
  console.log(formatContactLogEntry(entry))
}

/** Résultat d'une soumission. */
export type ContactSubmissionResult =
  | {
      ok: true
      reference: string
      status: ContactMessageStatus
      phoneMasked: string | null
      replayed: boolean
      notificationQueued: boolean
      submittedAt: number
    }
  | {
      ok: false
      code: ContactSubmissionFailureCode
      retryAfterSeconds?: number
    }

/** Nombre d'essais de génération d'une référence en cas de collision. */
const REFERENCE_ATTEMPTS = 5

/** Champs validés d'une soumission de contact. */
export type ValidatedContactInput = {
  contactName: string
  contactEmail: string
  phoneNormalized: string | null
  phoneRaw: string | null
  message: string
  idempotencyKey: string
}

/**
 * Valide les champs du formulaire de contact, ou rend le motif du refus.
 *
 * Seul le texte du message est propre à ce formulaire ; le reste vient de
 * `services/request-fields.ts`, partagé avec la demande de devis.
 */
export function validateContactInput(input: {
  name: string
  email: string
  phone: string | null
  message: string
  idempotencyKey: string | null
}):
  | { ok: true; value: ValidatedContactInput }
  | { ok: false; reason: ContactLogReason } {
  const fields = validateIntakeFields(input)
  if (!fields.ok) {
    const reasons: Record<IntakeFieldRefusal, ContactLogReason> = {
      name: 'invalid_name',
      email: 'invalid_email',
      phone: 'invalid_phone',
      idempotency_key: 'invalid_idempotency_key',
    }
    return { ok: false, reason: reasons[fields.field] }
  }

  const message = input.message.trim()
  if (!hasUsableTextLength(message)) {
    return { ok: false, reason: 'invalid_message' }
  }

  return { ok: true, value: { ...fields.value, message } }
}

/** Entrée du service de soumission d'un message de contact. */
export type ContactSubmissionInput = {
  db: Db
  notificationRecipient: string
  name: string
  email: string
  phone: string | null
  message: string
  idempotencyKey: string | null
  rateLimitSecret: string
  clientIp: string | null
  honeypot: string | null
  turnstileToken: string | null
  turnstileSecret?: string
  abusePolicy?: AbusePolicy
  now?: number
  log?: ContactRequestLogger
  fetchImplementation?: typeof fetch
}

/** Traduit une décision d'anti-abus en code public et motif de journal. */
function refusalFor(
  reason:
    | 'honeypot'
    | 'challenge_invalid'
    | 'ip_rate_limited'
    | 'email_rate_limited'
    | 'phone_rate_limited',
): {
  code: 'invalid_request' | 'challenge_failed' | 'too_many_requests'
  log: ContactLogReason
} {
  if (reason === 'honeypot') {
    return { code: 'invalid_request', log: 'abuse_honeypot' }
  }
  if (reason === 'challenge_invalid') {
    return { code: 'challenge_failed', log: 'abuse_challenge' }
  }
  return { code: 'too_many_requests', log: 'abuse_rate_limited' }
}

/**
 * Enregistre un message de contact, ou explique pourquoi il est refusé.
 *
 * La fonction ne lève jamais pour une cause prévisible : le résultat porte un code
 * public, et les causes précises restent dans les journaux.
 */
export async function submitContactMessage(
  input: ContactSubmissionInput,
): Promise<ContactSubmissionResult> {
  const now = input.now ?? nowSeconds()
  const log = input.log ?? contactConsoleLogger
  const report = (
    outcome: ContactLogEntry['outcome'],
    reason: ContactLogReason,
    extra: {
      phoneMasked?: string
      messageReference?: string
      dbCode?: DbFailureCode
      attempt?: number
    } = {},
  ): void => {
    log({ event: 'contact.submit', outcome, reason, ...extra })
  }

  // 1. Validation des champs.
  const validation = validateContactInput(input)
  if (!validation.ok) {
    report('refused', validation.reason)
    return { ok: false, code: 'invalid_request' }
  }
  const {
    contactName,
    contactEmail,
    phoneNormalized,
    phoneRaw,
    message,
    idempotencyKey,
  } = validation.value
  const masked =
    phoneNormalized === null ? null : maskPhoneNumber(phoneNormalized)
  const maskedField = masked === null ? {} : { phoneMasked: masked }

  // 2. Anti-abus : champ leurre, défi éventuel, limitation de débit.
  const decision = await checkFormAbuse({
    db: input.db,
    scope: 'contact_submit',
    secret: input.rateLimitSecret,
    clientIp: input.clientIp,
    email: contactEmail,
    phoneNormalized,
    honeypot: input.honeypot,
    turnstileToken: input.turnstileToken,
    ...(input.turnstileSecret === undefined
      ? {}
      : { turnstileSecret: input.turnstileSecret }),
    ...(input.abusePolicy === undefined ? {} : { policy: input.abusePolicy }),
    now,
    ...(input.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: input.fetchImplementation }),
  })
  if (!decision.ok) {
    if (decision.outcome === 'unavailable') {
      report('failed', 'abuse_unavailable', maskedField)
      return { ok: false, code: 'service_unavailable' }
    }
    const refusal = refusalFor(decision.reason)
    report('refused', refusal.log, maskedField)
    return {
      ok: false,
      code: refusal.code,
      ...(decision.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: decision.retryAfterSeconds }),
    }
  }

  // 3. Rejeu : une clé déjà connue renvoie le message existant, sans rien créer.
  try {
    const existing = await findContactMessageByIdempotencyKey(
      input.db,
      idempotencyKey,
    )
    if (existing !== null) {
      const existingMasked =
        existing.phone_normalized === null
          ? null
          : maskPhoneNumber(existing.phone_normalized)
      report('accepted', 'replayed', {
        messageReference: existing.reference,
        ...(existingMasked === null ? {} : { phoneMasked: existingMasked }),
      })
      return {
        ok: true,
        replayed: true,
        notificationQueued: false,
        reference: existing.reference,
        status: existing.status,
        phoneMasked: existingMasked,
        submittedAt: existing.created_at,
      }
    }
  } catch (error) {
    report('failed', 'storage_unavailable', {
      dbCode: toDbError(error).code,
      ...maskedField,
    })
    return { ok: false, code: 'service_unavailable' }
  }

  // 4. Création : la référence est tirée au sort, une collision est retentée.
  const year = new Date(now * 1000).getUTCFullYear()
  for (let attempt = 1; attempt <= REFERENCE_ATTEMPTS; attempt += 1) {
    const reference = generateContactReference({ year })
    const notification = buildContactNotification({
      recipient: input.notificationRecipient,
      reference,
      receivedAt: now,
      message,
      contactName,
      contactEmail,
      phoneNormalized,
    })

    try {
      const outcome = await createContactMessage(input.db, {
        reference,
        idempotencyKey,
        phoneNormalized,
        phoneRaw,
        message,
        contactName,
        contactEmail,
        notification,
        now,
      })

      if (!outcome.replayed && !outcome.notificationQueued) {
        report('failed', 'notification_unavailable', {
          messageReference: outcome.message.reference,
        })
        return { ok: false, code: 'service_unavailable' }
      }

      report('accepted', outcome.replayed ? 'replayed' : 'accepted', {
        messageReference: outcome.message.reference,
        ...maskedField,
      })
      return {
        ok: true,
        replayed: outcome.replayed,
        notificationQueued: outcome.notificationQueued,
        reference: outcome.message.reference,
        status: outcome.message.status,
        phoneMasked: masked,
        submittedAt: outcome.message.created_at,
      }
    } catch (error) {
      const dbError = toDbError(error)
      if (dbError.code === 'contact_reference_conflict') {
        report('failed', 'reference_conflict', { attempt, ...maskedField })
        continue
      }
      if (dbError.code === 'idempotency_key_reused') {
        const raced = await readRacedMessage({
          db: input.db,
          idempotencyKey,
          report,
        })
        if (raced !== null) {
          return raced
        }
      }
      report('failed', 'storage_unavailable', {
        dbCode: dbError.code,
        ...maskedField,
      })
      return { ok: false, code: 'service_unavailable' }
    }
  }

  report('failed', 'reference_conflict', {
    attempt: REFERENCE_ATTEMPTS,
    ...maskedField,
  })
  return { ok: false, code: 'service_unavailable' }
}

/**
 * Relit le message créé par un appel concurrent portant la même clé d'idempotence.
 *
 * Appelé uniquement après un échec `idempotency_key_reused` : le visiteur doit
 * obtenir la MÊME réponse que l'appel gagnant, jamais un doublon ni une erreur.
 */
async function readRacedMessage(input: {
  db: Db
  idempotencyKey: string
  report: (
    outcome: ContactLogEntry['outcome'],
    reason: ContactLogReason,
    extra?: { phoneMasked?: string; messageReference?: string },
  ) => void
}): Promise<ContactSubmissionResult | null> {
  try {
    const raced = await findContactMessageByIdempotencyKey(
      input.db,
      input.idempotencyKey,
    )
    if (raced === null) {
      return null
    }
    input.report('accepted', 'replayed', {
      messageReference: raced.reference,
    })
    return {
      ok: true,
      replayed: true,
      notificationQueued: false,
      reference: raced.reference,
      status: raced.status,
      phoneMasked:
        raced.phone_normalized === null
          ? null
          : maskPhoneNumber(raced.phone_normalized),
      submittedAt: raced.created_at,
    }
  } catch {
    return null
  }
}
