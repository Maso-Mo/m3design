/**
 * Soumission d'une demande de devis.
 *
 * Depuis la V1, le parcours est simple : le visiteur remplit un formulaire (nom et
 * adresse électronique obligatoires, téléphone facultatif, description obligatoire)
 * et sa demande est enregistrée. Il n'y a PLUS de vérification par code : le numéro
 * de téléphone n'est jamais présenté comme vérifié et ne sert qu'à rappeler le
 * client.
 *
 * Ce que le service garantit malgré tout, dans cet ordre :
 *
 *   1. VALIDATION : bornes alignées sur le schéma (`services/request-fields.ts`), un
 *      refus applicatif étant toujours plus clair qu'un refus de la base ;
 *   2. ANTI-ABUS : champ leurre, défi Turnstile si configuré, limitation de débit par
 *      empreinte (`services/abuse-guard.ts`) ;
 *   3. IDEMPOTENCE : une clé déjà connue renvoie la demande existante sans rien
 *      créer — un double clic ne produit pas deux demandes ;
 *   4. COHÉRENCE : demande, événement de création et notification de M3Design sont
 *      écrits dans le MÊME lot (tout ou rien). Une demande que personne ne verrait ne
 *      peut donc pas exister.
 *
 * Les causes précises d'un refus ne vivent que dans les journaux internes, qui ne
 * portent aucune donnée personnelle : numéro masqué et référence publique seulement.
 */

import { nowSeconds } from '../db/client'
import type { Db } from '../db/client'
import type { DbFailureCode } from '../db/errors'
import { toDbError } from '../db/errors'
import {
  createQuoteRequest,
  findQuoteRequestByIdempotencyKey,
} from '../db/repositories/quote-requests'
import type { QuoteRequestStatus } from '../db/repositories/quote-requests'
import { checkFormAbuse } from './abuse-guard'
import type { AbusePolicy } from './abuse-guard'
import { buildQuoteNotification } from './notifications'
import { maskPhoneNumber } from './phone'
import { generateQuoteReference } from './quote-reference'
import {
  hasUsableTextLength,
  textLength,
  validateIntakeFields,
} from './request-fields'
import type { IntakeFieldRefusal } from './request-fields'

/** Codes publics d'échec. Liste fermée. */
export type QuoteSubmissionFailureCode =
  | 'invalid_request'
  | 'request_rejected'
  | 'too_many_requests'
  | 'challenge_failed'
  | 'service_unavailable'

/** Causes internes d'une décision. Elles restent dans les journaux. */
export type QuoteLogReason =
  | 'accepted'
  | 'replayed'
  | 'invalid_name'
  | 'invalid_email'
  | 'invalid_description'
  | 'invalid_phone'
  | 'invalid_idempotency_key'
  | 'abuse_honeypot'
  | 'abuse_challenge'
  | 'abuse_rate_limited'
  | 'abuse_unavailable'
  | 'request_already_active'
  | 'reference_conflict'
  | 'storage_unavailable'
  | 'notification_unavailable'

/**
 * Entrée d'un journal de soumission.
 *
 * Garantie « aucune donnée personnelle dans les journaux » : ce type ne peut porter
 * ni nom, ni adresse électronique, ni description, ni numéro complet.
 */
export type QuoteLogEntry = {
  event: 'quote.submit'
  outcome: 'accepted' | 'refused' | 'failed'
  reason: QuoteLogReason
  phoneMasked?: string
  quoteReference?: string
  dbCode?: DbFailureCode
  attempt?: number
}

/** Journaliseur injectable : les tests collectent les entrées sans I/O. */
export type QuoteRequestLogger = (entry: QuoteLogEntry) => void

/** Sérialisation d'une entrée en une ligne unique, sans donnée personnelle. */
export function formatQuoteLogEntry(entry: QuoteLogEntry): string {
  return `[quote] ${JSON.stringify(entry)}`
}

/** Journaliseur par défaut (Cloudflare collecte la sortie standard). */
export const quoteConsoleLogger: QuoteRequestLogger = (entry) => {
  console.log(formatQuoteLogEntry(entry))
}

/** Résultat d'une soumission. */
export type QuoteSubmissionResult =
  | {
      ok: true
      reference: string
      status: QuoteRequestStatus
      /** Numéro masqué, ou `null` si le visiteur n'en a pas fourni. */
      phoneMasked: string | null
      replayed: boolean
      notificationQueued: boolean
      submittedAt: number
    }
  | {
      ok: false
      code: QuoteSubmissionFailureCode
      /** Attente conseillée, renseignée pour une limitation de débit. */
      retryAfterSeconds?: number
    }

/** Nombre d'essais de génération d'une référence en cas de collision. */
const REFERENCE_ATTEMPTS = 5

/**
 * Normalise l'adresse IP transmise par Cloudflare.
 *
 * L'adresse n'est jamais stockée ni journalisée : elle ne sert qu'à calculer une
 * empreinte de limitation.
 */
export function readClientIp(
  headerValue: string | null | undefined,
): string | null {
  const value = (headerValue ?? '').trim()
  if (value === '' || textLength(value) > 64) {
    return null
  }
  return value
}

/** Champs validés d'une soumission. */
export type ValidatedQuoteInput = {
  contactName: string
  contactEmail: string
  phoneNormalized: string | null
  phoneRaw: string | null
  description: string
  idempotencyKey: string
}

/**
 * Valide et normalise les champs du formulaire, ou rend le motif du refus.
 *
 * Les règles de saisie viennent de `services/request-fields.ts`, aligné sur les
 * contraintes du schéma : la base refuserait de toute façon une valeur hors bornes,
 * mais elle ne peut pas expliquer au visiteur ce qu'il a mal saisi.
 */
export function validateQuoteInput(input: {
  name: string
  email: string
  phone: string | null
  description: string
  idempotencyKey: string | null
}):
  | { ok: true; value: ValidatedQuoteInput }
  | { ok: false; reason: QuoteLogReason } {
  const fields = validateIntakeFields(input)
  if (!fields.ok) {
    const reasons: Record<IntakeFieldRefusal, QuoteLogReason> = {
      name: 'invalid_name',
      email: 'invalid_email',
      phone: 'invalid_phone',
      idempotency_key: 'invalid_idempotency_key',
    }
    return { ok: false, reason: reasons[fields.field] }
  }

  const description = input.description.trim()
  if (!hasUsableTextLength(description)) {
    return { ok: false, reason: 'invalid_description' }
  }

  return { ok: true, value: { ...fields.value, description } }
}

/** Entrée du service de soumission d'une demande de devis. */
export type QuoteSubmissionInput = {
  db: Db
  /** Boîte qui reçoit les demandes (`NOTIFICATION_EMAIL`). */
  notificationRecipient: string
  name: string
  email: string
  phone: string | null
  description: string
  idempotencyKey: string | null
  /** Secret de hachage des empreintes de limitation (`RATE_LIMIT_SECRET`). */
  rateLimitSecret: string
  /** Adresse réseau du visiteur, telle que fournie par Cloudflare. */
  clientIp: string | null
  /** Champ leurre : doit rester vide. */
  honeypot: string | null
  turnstileToken: string | null
  turnstileSecret?: string
  abusePolicy?: AbusePolicy
  now?: number
  log?: QuoteRequestLogger
  fetchImplementation?: typeof fetch
}

/** Motif public traduit depuis une décision d'anti-abus. */
function publicCodeForRefusal(
  reason:
    | 'honeypot'
    | 'challenge_invalid'
    | 'ip_rate_limited'
    | 'email_rate_limited'
    | 'phone_rate_limited',
): {
  code: 'invalid_request' | 'challenge_failed' | 'too_many_requests'
  log: QuoteLogReason
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
 * Enregistre une demande de devis, ou explique pourquoi elle est refusée.
 *
 * La fonction ne lève jamais pour une cause prévisible : le résultat porte un code
 * public, et les causes précises restent dans les journaux.
 */
export async function submitQuoteRequest(
  input: QuoteSubmissionInput,
): Promise<QuoteSubmissionResult> {
  const now = input.now ?? nowSeconds()
  const log = input.log ?? quoteConsoleLogger
  const report = (
    outcome: QuoteLogEntry['outcome'],
    reason: QuoteLogReason,
    extra: {
      phoneMasked?: string
      quoteReference?: string
      dbCode?: DbFailureCode
      attempt?: number
    } = {},
  ): void => {
    log({ event: 'quote.submit', outcome, reason, ...extra })
  }

  // 1. Validation des champs.
  const validation = validateQuoteInput(input)
  if (!validation.ok) {
    report('refused', validation.reason)
    return { ok: false, code: 'invalid_request' }
  }
  const {
    contactName,
    contactEmail,
    phoneNormalized,
    phoneRaw,
    description,
    idempotencyKey,
  } = validation.value
  const masked =
    phoneNormalized === null ? null : maskPhoneNumber(phoneNormalized)
  const maskedField = masked === null ? {} : { phoneMasked: masked }

  // 2. Anti-abus : champ leurre, défi éventuel, limitation de débit.
  const decision = await checkFormAbuse({
    db: input.db,
    scope: 'quote_submit',
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
    const refusal = publicCodeForRefusal(decision.reason)
    report('refused', refusal.log, maskedField)
    return {
      ok: false,
      code: refusal.code,
      ...(decision.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: decision.retryAfterSeconds }),
    }
  }

  // 3. Rejeu : une clé déjà connue renvoie la demande existante, sans rien créer.
  try {
    const existing = await findQuoteRequestByIdempotencyKey(
      input.db,
      idempotencyKey,
    )
    if (existing !== null) {
      const existingMasked =
        existing.phone_normalized === null
          ? null
          : maskPhoneNumber(existing.phone_normalized)
      report('accepted', 'replayed', {
        quoteReference: existing.reference,
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
    const reference = generateQuoteReference({ year })
    const notification = buildQuoteNotification({
      recipient: input.notificationRecipient,
      reference,
      receivedAt: now,
      description,
      contactName,
      contactEmail,
      phoneNormalized,
    })

    try {
      const outcome = await createQuoteRequest(input.db, {
        reference,
        idempotencyKey,
        phoneNormalized,
        phoneRaw,
        description,
        contactName,
        contactEmail,
        notification,
        now,
      })

      if (!outcome.replayed && !outcome.notificationQueued) {
        // La demande existe, mais personne n'a été prévenu : ce n'est pas une
        // acceptation. On le dit, sans la compter comme traitée.
        report('failed', 'notification_unavailable', {
          quoteReference: outcome.quote.reference,
        })
        return { ok: false, code: 'service_unavailable' }
      }

      report('accepted', outcome.replayed ? 'replayed' : 'accepted', {
        quoteReference: outcome.quote.reference,
        ...maskedField,
      })
      return {
        ok: true,
        replayed: outcome.replayed,
        notificationQueued: outcome.notificationQueued,
        reference: outcome.quote.reference,
        status: outcome.quote.status,
        phoneMasked: masked,
        submittedAt: outcome.quote.created_at,
      }
    } catch (error) {
      const dbError = toDbError(error)
      if (dbError.code === 'quote_reference_conflict') {
        report('failed', 'reference_conflict', { attempt, ...maskedField })
        continue
      }
      if (dbError.code === 'quote_already_active') {
        report('refused', 'request_already_active', maskedField)
        return { ok: false, code: 'request_rejected' }
      }
      if (dbError.code === 'idempotency_key_reused') {
        // Course réelle : un autre appel a créé la demande entre-temps.
        const raced = await readRacedQuote({
          db: input.db,
          idempotencyKey,
          maskedField,
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
 * Relit la demande créée par un appel concurrent portant la même clé d'idempotence.
 *
 * Appelé uniquement après un échec `idempotency_key_reused` : un autre appel a gagné
 * la course, et le visiteur doit obtenir la MÊME réponse que lui plutôt qu'une
 * erreur. Renvoie `null` si la relecture échoue, auquel cas l'appelant répond
 * « service indisponible » — jamais un doublon.
 */
async function readRacedQuote(input: {
  db: Db
  idempotencyKey: string
  maskedField: { phoneMasked?: string }
  report: (
    outcome: QuoteLogEntry['outcome'],
    reason: QuoteLogReason,
    extra?: { phoneMasked?: string; quoteReference?: string },
  ) => void
}): Promise<QuoteSubmissionResult | null> {
  try {
    const raced = await findQuoteRequestByIdempotencyKey(
      input.db,
      input.idempotencyKey,
    )
    if (raced === null) {
      return null
    }
    input.report('accepted', 'replayed', {
      quoteReference: raced.reference,
      ...input.maskedField,
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
