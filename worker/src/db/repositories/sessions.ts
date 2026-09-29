/**
 * Dépôt des sessions administratives.
 *
 * Le jeton de session n'existe qu'en mémoire, côté client (cookie `HttpOnly`). La
 * base ne reçoit que son empreinte SHA-256 hexadécimale : une fuite de la base ne
 * permet donc pas de rejouer une session. Aucune donnée de suivi (adresse IP,
 * navigateur) n'est enregistrée : le schéma ne les prévoit pas, et ce module ne les
 * accepte pas non plus.
 *
 * Une session est utilisable si, et seulement si : elle existe, n'a pas été
 * révoquée, n'est pas expirée, et son compte est actif. Cette dernière condition est
 * vérifiée par la jointure de `findActiveAdminSession`, afin qu'une désactivation de
 * compte soit immédiatement effective même si une session survivait (voir aussi la
 * révocation en masse dans `setAdminUserStatus`).
 */

import { clampLimit, nowSeconds, type Db } from '../client'
import { changedRows, DbError, toDbError } from '../errors'
import type { AdminUserStatus } from './users'

/** Ligne de `sessions` telle que renvoyée par la base. */
export type AdminSessionRow = {
  id: number
  user_id: number
  token_hash: string
  created_at: number
  expires_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

/**
 * Session active jointe à l'état du compte, en une seule lecture cohérente.
 *
 * Les colonnes sont préfixées par leur origine (`session_` / `user_` / sans
 * préfixe pour l'identité du compte) afin d'éviter toute ambiguïté de nom.
 */
export type ActiveAdminSessionRow = {
  session_id: number
  user_id: number
  token_hash: string
  expires_at: number
  last_seen_at: number | null
  session_created_at: number
  user_email: string
  user_display_name: string
  user_status: AdminUserStatus
  user_locked_until: number | null
}

/** Colonnes de session renvoyées par les lectures simples. */
const COLUMNS = `id, user_id, token_hash, created_at, expires_at, last_seen_at, revoked_at`

/** Une empreinte de jeton est un SHA-256 hexadécimal minuscule (64 caractères). */
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

/** Refuse toute empreinte de jeton qui ne serait pas un SHA-256 hexadécimal. */
function assertTokenHash(tokenHash: string): void {
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw new DbError('invalid_input')
  }
}

/** Durées minimales, pour ne jamais écrire une expiration absurde. */
function positiveSeconds(value: number, minimum = 1): number {
  return Math.max(Math.floor(value), minimum)
}

/**
 * Ouvre une session pour un compte.
 *
 * `tokenHash` doit être l'empreinte SHA-256 hexadécimale du jeton remis au client ;
 * la génération du jeton et son envoi appartiennent à la couche service. La forme
 * attendue est vérifiée ici, ce qui interdit d'écrire un jeton en clair même par
 * erreur de programmation.
 */
export async function createAdminSession(
  db: Db,
  input: {
    userId: number
    tokenHash: string
    ttlSeconds: number
    now?: number
  },
): Promise<AdminSessionRow> {
  assertTokenHash(input.tokenHash)
  const now = input.now ?? nowSeconds()
  const expiresAt = now + positiveSeconds(input.ttlSeconds)

  try {
    const created = await db
      .prepare(
        `INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4)
         RETURNING ${COLUMNS}`,
      )
      .bind(input.userId, input.tokenHash, now, expiresAt)
      .first<AdminSessionRow>()

    if (!created) {
      throw new DbError('db_unavailable')
    }
    return created
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Session active correspondant à une empreinte de jeton, avec l'état du compte.
 *
 * Renvoie `null` si la session est inconnue, révoquée ou expirée. Un compte
 * désactivé ou verrouillé peut encore avoir une session stockée : c'est à la couche
 * service de refuser l'accès, et les colonnes `user_status` / `user_locked_until`
 * sont renvoyées précisément pour cela.
 */
export async function findActiveAdminSession(
  db: Db,
  input: { tokenHash: string; now?: number },
): Promise<ActiveAdminSessionRow | null> {
  assertTokenHash(input.tokenHash)
  const now = input.now ?? nowSeconds()

  const row = await db
    .prepare(
      `SELECT session.id AS session_id,
              session.user_id AS user_id,
              session.token_hash AS token_hash,
              session.expires_at AS expires_at,
              session.last_seen_at AS last_seen_at,
              session.created_at AS session_created_at,
              account.email AS user_email,
              account.display_name AS user_display_name,
              account.status AS user_status,
              account.locked_until AS user_locked_until
         FROM sessions AS session
         JOIN users AS account ON account.id = session.user_id
        WHERE session.token_hash = ?1
          AND session.revoked_at IS NULL
          AND session.expires_at > ?2`,
    )
    .bind(input.tokenHash, now)
    .first<ActiveAdminSessionRow>()

  return row ?? null
}

/**
 * Met à jour la date de dernière activité d'une session.
 *
 * Écriture volontairement « best effort » et idempotente : elle ne prolonge jamais
 * la session (seule `expires_at` décide de la fin) et ne sert qu'à l'exploitation
 * (repérer une session abandonnée). La couche service limite la fréquence de ces
 * écritures, pour ne pas écrire à chaque requête.
 */
export async function touchAdminSession(
  db: Db,
  input: { sessionId: number; now?: number },
): Promise<boolean> {
  const now = input.now ?? nowSeconds()

  const result = await db
    .prepare(
      `UPDATE sessions
          SET last_seen_at = ?2
        WHERE id = ?1
          AND revoked_at IS NULL
          AND expires_at > ?2`,
    )
    .bind(input.sessionId, now)
    .run()

  return changedRows(result) > 0
}

/**
 * Révoque une session (déconnexion).
 *
 * Renvoie `false` si aucune session active ne correspond : la couche service traite
 * ce cas comme une déconnexion déjà effectuée, sans le distinguer auprès du client.
 */
export async function revokeAdminSession(
  db: Db,
  input: { tokenHash: string; now?: number },
): Promise<boolean> {
  assertTokenHash(input.tokenHash)
  const now = input.now ?? nowSeconds()

  const result = await db
    .prepare(
      `UPDATE sessions
          SET revoked_at = ?2
        WHERE token_hash = ?1
          AND revoked_at IS NULL
          AND created_at <= ?2`,
    )
    .bind(input.tokenHash, now)
    .run()

  return changedRows(result) > 0
}

/**
 * Révoque toutes les sessions d'un compte, éventuellement sauf une.
 *
 * Cas d'usage : changement de mot de passe ou incident de sécurité. L'exception
 * permet de conserver la session courante si la couche service le décide. Renvoie
 * le nombre de sessions effectivement révoquées.
 */
export async function revokeAdminUserSessions(
  db: Db,
  input: { userId: number; exceptSessionId?: number | null; now?: number },
): Promise<number> {
  const now = input.now ?? nowSeconds()
  const exceptSessionId = input.exceptSessionId ?? null

  try {
    const result = await db
      .prepare(
        `UPDATE sessions
            SET revoked_at = ?2
          WHERE user_id = ?1
            AND revoked_at IS NULL
            AND created_at <= ?2
            AND (?3 IS NULL OR id <> ?3)`,
      )
      .bind(input.userId, now, exceptSessionId)
      .run()

    return changedRows(result)
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Purge les sessions révoquées ou expirées, par lots bornés.
 *
 * Les sessions actives ne sont jamais touchées. La purge évite que la table
 * grossisse indéfiniment et limite la portée d'un éventuel vol de base : une
 * empreinte de jeton ne sert à rien une fois la session clôturée.
 */
export async function purgeAdminSessions(
  db: Db,
  input: { revokedBefore: number; limit?: number; now?: number },
): Promise<number> {
  const now = input.now ?? nowSeconds()
  const limit = clampLimit(input.limit, 200, 1000)

  try {
    const result = await db
      .prepare(
        `DELETE FROM sessions
          WHERE id IN (
            SELECT session.id FROM sessions AS session
             WHERE (session.revoked_at IS NOT NULL AND session.revoked_at <= ?1)
                OR session.expires_at <= ?2
             ORDER BY session.expires_at
             LIMIT ?3
          )`,
      )
      .bind(input.revokedBefore, now, limit)
      .run()

    return changedRows(result)
  } catch (error) {
    throw toDbError(error)
  }
}
