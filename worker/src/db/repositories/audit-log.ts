/**
 * Dépôt du journal d'audit administratif.
 *
 * Le journal répond à une seule question : « qui a fait quoi, quand, avec quel
 * résultat ». Il est en ajout seul et n'enregistre AUCUNE valeur sensible : la
 * référence publique de l'entité (par exemple `DEV-2026-XXXXXXXX`), jamais un
 * numéro de téléphone, une adresse électronique ou un contenu de message.
 *
 * La conservation est celle du schéma : le journal n'est pas purgé par les
 * traitements de minimisation, car il ne contient pas de donnée personnelle
 * directe et sert de preuve en cas d'incident.
 */

import { clampLimit, nowSeconds, type Db } from '../client'
import { DbError, toDbError } from '../errors'

/** Type d'entité auditée, aligné sur `ck_audit_log_entity_type`. */
export type AuditEntityType =
  | 'quote_request'
  | 'user'
  | 'session'
  // Valeur HISTORIQUE : plus aucun code ne l'écrit depuis l'abandon de la
  // vérification par code (migration 0008), mais des lignes anciennes la portent.
  | 'otp_challenge'
  | 'email_outbox'
  | 'system'

/** Résultat de l'action auditée, aligné sur `ck_audit_log_outcome`. */
export type AuditOutcome = 'success' | 'failure' | 'denied'

/** Ligne de `audit_log` telle que renvoyée par la base. */
export type AuditLogRow = {
  id: number
  occurred_at: number
  action: string
  entity_type: AuditEntityType
  entity_reference: string | null
  outcome: AuditOutcome
  actor_user_id: number | null
  reason: string | null
}

/** Colonnes renvoyées par toute lecture d'audit. */
const COLUMNS = `id, occurred_at, action, entity_type, entity_reference, outcome,
  actor_user_id, reason`

/**
 * Ajoute une entrée au journal d'audit.
 *
 * `action` est un nom technique stable (« quote.close », « session.revoke ») : il
 * doit rester exploitable par recherche et ne pas dépendre de la langue de
 * l'interface. `reason` est un motif technique court, jamais un message client.
 * L'action est volontairement écrite même en cas d'échec (`outcome`), car une
 * tentative refusée est justement ce qu'un audit doit pouvoir relire.
 */
export async function appendAuditLog(
  db: Db,
  input: {
    action: string
    entityType: AuditEntityType
    outcome: AuditOutcome
    entityReference?: string | null
    actorUserId?: number | null
    reason?: string | null
    now?: number
  },
): Promise<AuditLogRow> {
  const now = input.now ?? nowSeconds()

  try {
    const created = await db
      .prepare(
        `INSERT INTO audit_log (
           occurred_at, action, entity_type, entity_reference, outcome, actor_user_id, reason
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         RETURNING ${COLUMNS}`,
      )
      .bind(
        now,
        input.action,
        input.entityType,
        input.entityReference ?? null,
        input.outcome,
        input.actorUserId ?? null,
        input.reason ?? null,
      )
      .first<AuditLogRow>()

    if (!created) {
      throw new DbError('db_unavailable')
    }
    return created
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Entrées d'audit d'une entité, de la plus récente à la plus ancienne.
 *
 * Utilisé par l'administration pour retracer les actions sur une demande ou un
 * compte. Les entrées sont bornées, et la recherche se fait sur la référence
 * publique, jamais sur un identifiant interne.
 */
export async function listAuditLogForEntity(
  db: Db,
  input: {
    entityType: AuditEntityType
    entityReference: string
    limit?: number
  },
): Promise<AuditLogRow[]> {
  const limit = clampLimit(input.limit, 100, 500)
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM audit_log
        WHERE entity_type = ?1 AND entity_reference = ?2
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?3`,
    )
    .bind(input.entityType, input.entityReference, limit)
    .all<AuditLogRow>()

  return result.results ?? []
}
