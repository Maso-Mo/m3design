/**
 * Dépôt de l'historique des demandes de devis.
 *
 * L'historique est en ajout seul : ces tables ne sont jamais modifiées après
 * coup, seulement complétées (ou purgées par le traitement de conservation, qui
 * supprime les demandes anonymisées avec elles). C'est ce qui rend le déroulé d'une
 * demande vérifiable : qui a fait quoi, quand, et à partir de quel état.
 *
 * Aucune donnée personnelle n'y est écrite : ni numéro, ni adresse électronique,
 * ni texte du besoin. Le motif (`reason`) est un libellé technique court décidé par
 * le serveur, jamais un message recopié d'un client.
 */

import { clampLimit, nowSeconds, type Db } from '../client'
import { DbError, toDbError } from '../errors'

/** Nature de l'événement, alignée sur `ck_request_event_type`. */
export type RequestEventType =
  | 'created'
  | 'phone_verified' // valeur HISTORIQUE : plus jamais écrite par l'application
  | 'status_changed'
  | 'corrected'
  | 'notification_queued'
  | 'anonymized'

/** Auteur de l'action, aligné sur `ck_request_event_actor`. */
export type RequestEventActor = 'client' | 'admin' | 'system'

/** États de demande, dupliqués ici pour éviter un couplage entre dépôts. */
/**
 * États d'une opération, alignés sur `ck_request_event_*_status` (migration 0008).
 *
 * Depuis la V1, une demande naît en `new` : ni `pending` (qui supposait un numéro non
 * encore vérifié) ni `verified` (la vérification par code n'existe plus) ne sont
 * produits. Les événements HISTORIQUES peuvent en revanche encore les porter : la
 * migration 0008 les a traduits en `new`, mais un `event_type` `phone_verified` reste
 * possible, d'où sa présence dans la liste ci-dessus, marquée comme héritée.
 */
export type RequestEventStatus = 'new' | 'in_progress' | 'closed'

/** Ligne de `request_events` telle que renvoyée par la base. */
export type RequestEventRow = {
  id: number
  /** Demande de devis concernée, `null` pour un événement de message de contact. */
  quote_request_id: number | null
  /** Message de contact concerné, `null` pour un événement de devis. */
  contact_message_id: number | null
  event_type: RequestEventType
  from_status: RequestEventStatus | null
  to_status: RequestEventStatus | null
  actor: RequestEventActor
  actor_user_id: number | null
  reason: string | null
  created_at: number
}

/** Colonnes renvoyées par toute lecture d'événement. */
const COLUMNS = `id, quote_request_id, contact_message_id, event_type, from_status,
  to_status, actor, actor_user_id, reason, created_at`

/**
 * Insertion commune aux deux propriétaires possibles.
 *
 * Le propriétaire est exactement l'un des deux identifiants : la base le vérifie
 * (`ck_request_event_owner`), donc une ligne sans propriétaire ou avec deux
 * propriétaires est impossible même si un appelant se trompait ici.
 */
async function insertRequestEvent(
  db: Db,
  input: {
    quoteRequestId?: number | null
    contactMessageId?: number | null
    eventType: RequestEventType
    actor: RequestEventActor
    fromStatus?: RequestEventStatus | null
    toStatus?: RequestEventStatus | null
    actorUserId?: number | null
    reason?: string | null
    now?: number
  },
): Promise<RequestEventRow> {
  const now = input.now ?? nowSeconds()

  try {
    const created = await db
      .prepare(
        `INSERT INTO request_events (
           quote_request_id, contact_message_id, event_type, from_status, to_status,
           actor, actor_user_id, reason, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         RETURNING ${COLUMNS}`,
      )
      .bind(
        input.quoteRequestId ?? null,
        input.contactMessageId ?? null,
        input.eventType,
        input.fromStatus ?? null,
        input.toStatus ?? null,
        input.actor,
        input.actorUserId ?? null,
        input.reason ?? null,
        now,
      )
      .first<RequestEventRow>()

    if (!created) {
      throw new DbError('db_unavailable')
    }
    return created
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Ajoute un événement à l'historique d'une demande de devis.
 *
 * L'insertion est faite en une seule instruction : aucun état intermédiaire n'est
 * possible. La couche service décide du type et du motif ; la base vérifie la
 * cohérence (types autorisés, cohérence entre `event_type` et les états).
 */
export async function appendRequestEvent(
  db: Db,
  input: {
    quoteRequestId: number
    eventType: RequestEventType
    actor: RequestEventActor
    fromStatus?: RequestEventStatus | null
    toStatus?: RequestEventStatus | null
    actorUserId?: number | null
    reason?: string | null
    now?: number
  },
): Promise<RequestEventRow> {
  return insertRequestEvent(db, input)
}

/**
 * Ajoute un événement à l'historique d'un message de contact.
 *
 * Un seul type d'événement est accepté pour ce propriétaire (`created`) : c'est ce
 * que la base impose (`ck_request_event_contact_type`), et le limiter ici évite
 * d'écrire un événement que la base refuserait. Aucune donnée personnelle n'entre
 * dans l'historique : ni numéro, ni adresse, ni texte du message.
 */
export async function appendContactEvent(
  db: Db,
  input: {
    contactMessageId: number
    eventType: 'created'
    actor: RequestEventActor
    toStatus?: RequestEventStatus | null
    actorUserId?: number | null
    reason?: string | null
    now?: number
  },
): Promise<RequestEventRow> {
  return insertRequestEvent(db, input)
}

/**
 * Historique d'une demande, du plus ancien au plus récent.
 *
 * Sert à reconstituer le parcours d'une demande (support, litiges). Les entrées
 * sont bornées : un historique ne doit pas devenir une charge d'affichage ou de
 * mémoire.
 */
export async function listRequestEvents(
  db: Db,
  input: { quoteRequestId: number; limit?: number },
): Promise<RequestEventRow[]> {
  const limit = clampLimit(input.limit, 100, 500)
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM request_events
        WHERE quote_request_id = ?1
        ORDER BY created_at, id
        LIMIT ?2`,
    )
    .bind(input.quoteRequestId, limit)
    .all<RequestEventRow>()

  return result.results ?? []
}
