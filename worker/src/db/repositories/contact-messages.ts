/**
 * Dépôt des messages reçus par le formulaire de contact.
 *
 * Un message suit le même parcours qu'une demande de devis, avec une différence de
 * nature : ce n'est pas une commande, mais une prise de contact. Le dépôt applique
 * donc les mêmes règles qu'ailleurs — référence publique générée côté base en cas
 * de collision, clé d'idempotence unique, preuve de vérification du numéro
 * obligatoire et consommable une seule fois — sans ajouter de règle métier.
 *
 * Trois écritures sont faites d'un seul lot, donc en tout ou rien :
 *   1. le message lui-même ;
 *   2. son événement de création (historique en ajout seul, sans donnée
 *      personnelle) ;
 *   3. la notification de M3Design, si un destinataire est configuré.
 *
 * Pourquoi dans le même lot : un message reçu dont personne n'est prévenu serait
 * silencieusement perdu. Si la notification ne peut pas être mise en file, le
 * message n'est pas créé et le client est invité à réessayer.
 */

import { nowSeconds, type Db } from '../client'
import { changedRows, DbError, toDbError } from '../errors'

/** États d'un message, alignés sur `ck_contact_status`. */
export type ContactMessageStatus = 'new' | 'in_progress' | 'closed'

/** Ligne de `contact_messages`, telle que renvoyée par la base. */
export type ContactMessageRow = {
  id: number
  reference: string
  phone_normalized: string | null
  phone_raw: string | null
  contact_name: string | null
  contact_email: string | null
  message: string | null
  status: ContactMessageStatus
  /** Version du formulaire (1 = historique vérifié par code, 2 = V1). */
  intake_version: number
  idempotency_key: string
  created_at: number
  updated_at: number
  closed_at: number | null
  anonymized_at: number | null
}

/** Notification à mettre en file dans le même lot que le message. */
export type ContactNotificationDraft = {
  recipient: string
  subject: string
  bodyText: string
}

export type CreateContactMessageInput = {
  reference: string
  idempotencyKey: string
  /** Téléphone facultatif, jamais vérifié : il sert au rappel du client. */
  phoneNormalized: string | null
  phoneRaw: string | null
  message: string
  contactName: string | null
  contactEmail: string | null
  notification?: ContactNotificationDraft | null
  now?: number
}

export type CreateContactMessageOutcome = {
  message: ContactMessageRow
  /** Vrai lorsque la clé d'idempotence était déjà connue : aucune ligne créée. */
  replayed: boolean
  /** Vrai lorsque la notification de M3Design a été mise en file par ce lot. */
  notificationQueued: boolean
}

/** Colonnes renvoyées par toute lecture de message. */
const COLUMNS = `id, reference, phone_normalized, phone_raw, contact_name, contact_email,
  message, status, intake_version, idempotency_key,
  created_at, updated_at, closed_at, anonymized_at`

/** Lecture d'un message par sa clé d'idempotence (rejeu d'un appel déjà abouti). */
export async function findContactMessageByIdempotencyKey(
  db: Db,
  idempotencyKey: string,
): Promise<ContactMessageRow | null> {
  try {
    const row = await db
      .prepare(
        `SELECT ${COLUMNS} FROM contact_messages WHERE idempotency_key = ?1`,
      )
      .bind(idempotencyKey)
      .first<ContactMessageRow>()
    return row ?? null
  } catch (error) {
    throw toDbError(error)
  }
}

/** Lecture d'un message par sa référence publique (support, réponse). */
export async function findContactMessageByReference(
  db: Db,
  reference: string,
): Promise<ContactMessageRow | null> {
  try {
    const row = await db
      .prepare(`SELECT ${COLUMNS} FROM contact_messages WHERE reference = ?1`)
      .bind(reference)
      .first<ContactMessageRow>()
    return row ?? null
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Crée un message de contact.
 *
 * Trois écritures dans UN SEUL lot, donc en tout ou rien :
 *   1. le message lui-même ;
 *   2. son événement de création (historique en ajout seul, sans donnée personnelle) ;
 *   3. la notification de M3Design, si un destinataire est fourni.
 *
 * Pourquoi dans le même lot : un message reçu dont personne n'est prévenu serait
 * silencieusement perdu. Si la notification ne peut pas être mise en file, le
 * message n'est pas créé et le visiteur est invité à réessayer.
 *
 * Le rejeu d'une même clé d'idempotence ne crée jamais de second message : la ligne
 * déjà enregistrée est renvoyée avec `replayed: true`.
 */
export async function createContactMessage(
  db: Db,
  input: CreateContactMessageInput,
): Promise<CreateContactMessageOutcome> {
  const alreadyStored = await findContactMessageByIdempotencyKey(
    db,
    input.idempotencyKey,
  )
  if (alreadyStored) {
    return { message: alreadyStored, replayed: true, notificationQueued: false }
  }

  const now = input.now ?? nowSeconds()
  const notification = input.notification ?? null

  const statements = [
    db
      .prepare(
        `INSERT INTO contact_messages (
           reference, phone_normalized, phone_raw, contact_name, contact_email,
           message, status, idempotency_key, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7, ?8, ?8)
         RETURNING ${COLUMNS}`,
      )
      .bind(
        input.reference,
        input.phoneNormalized,
        input.phoneRaw,
        input.contactName,
        input.contactEmail,
        input.message,
        input.idempotencyKey,
        now,
      ),
    db
      .prepare(
        `INSERT INTO request_events (
           contact_message_id, event_type, actor, from_status, to_status, created_at
         )
         SELECT id, 'created', 'client', NULL, status, ?2
           FROM contact_messages
          WHERE idempotency_key = ?1`,
      )
      .bind(input.idempotencyKey, now),
  ]

  if (notification !== null) {
    // Même règle anti-doublon que côté file : une seule notification VIVANTE par
    // message, la base tranchant en dernier ressort (index unique partiel).
    statements.push(
      db
        .prepare(
          `INSERT INTO email_outbox (
             contact_message_id, recipient, subject, body_text, status,
             next_attempt_at, created_at
           )
           SELECT id, ?2, ?3, ?4, 'pending', ?5, ?5
             FROM contact_messages
            WHERE idempotency_key = ?1
              AND NOT EXISTS (
                SELECT 1 FROM email_outbox AS existing
                 WHERE existing.contact_message_id = contact_messages.id
                   AND existing.status IN ('pending', 'sending', 'sent')
              )`,
        )
        .bind(
          input.idempotencyKey,
          notification.recipient,
          notification.subject,
          notification.bodyText,
          now,
        ),
    )
  }

  try {
    const results = await db.batch(statements)

    const created = results[0]?.results?.[0] as ContactMessageRow | undefined
    if (!created) {
      throw new DbError('db_unavailable')
    }
    return {
      message: created,
      replayed: false,
      notificationQueued: notification !== null && changedRows(results[2]) > 0,
    }
  } catch (error) {
    throw toDbError(error)
  }
}
