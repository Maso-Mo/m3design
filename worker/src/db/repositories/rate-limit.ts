/**
 * Dépôt de la limitation d'abus (fenêtre glissante).
 *
 * Rien de personnel n'est stocké : la cible d'une tentative (numéro, adresse de
 * connexion, empreinte d'adresse) est transformée par la couche service en
 * empreinte HMAC-SHA-256 hexadécimale avant d'arriver ici. La base ne peut donc pas
 * servir de liste de numéros ou d'adresses, même en cas de fuite.
 *
 * Comptage en fenêtre glissante : le nombre de tentatives est compté depuis une
 * date de début, et la purge supprime les lignes trop anciennes. Aucune remise à
 * zéro périodique n'est nécessaire, ce qui évite les effets de bord aux bornes de
 * période (un pic à cheval sur deux périodes reste comptabilisé).
 */

import { clampLimit, nowSeconds, type Db } from '../client'
import { changedRows, DbError, toDbError } from '../errors'

/** Action limitée, alignée sur `ck_rate_limit_hits_scope`. */
export type RateLimitScope = 'quote_submit' | 'contact_submit' | 'admin_login'

/** Empreinte attendue : HMAC-SHA-256 hexadécimal minuscule. */
const KEY_HASH_PATTERN = /^[0-9a-f]{64}$/

/** Refuse toute clé qui ne serait pas une empreinte : aucune donnée en clair ici. */
function assertKeyHash(keyHash: string): void {
  if (!KEY_HASH_PATTERN.test(keyHash)) {
    throw new DbError('invalid_input')
  }
}

/**
 * Enregistre une tentative.
 *
 * Une tentative est enregistrée AVANT de décider : c'est ce qui rend la limitation
 * fiable, y compris face à des requêtes simultanées (les deux comptent leur
 * tentative, puis la décision est prise sur un comptage commun).
 */
export async function recordRateLimitHit(
  db: Db,
  input: { scope: RateLimitScope; keyHash: string; now?: number },
): Promise<void> {
  assertKeyHash(input.keyHash)
  const now = input.now ?? nowSeconds()

  try {
    await db
      .prepare(
        `INSERT INTO rate_limit_hits (scope, key_hash, created_at) VALUES (?1, ?2, ?3)`,
      )
      .bind(input.scope, input.keyHash, now)
      .run()
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Nombre de tentatives depuis `since` pour une action et une cible données.
 *
 * S'appuie sur `ix_rate_limit_hits_scope_key_created_at` : le comptage reste borné
 * même avec un historique fourni.
 */
export async function countRateLimitHits(
  db: Db,
  input: { scope: RateLimitScope; keyHash: string; since: number },
): Promise<number> {
  assertKeyHash(input.keyHash)
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM rate_limit_hits
        WHERE scope = ?1 AND key_hash = ?2 AND created_at >= ?3`,
    )
    .bind(input.scope, input.keyHash, input.since)
    .first<{ total: number }>()
  return row?.total ?? 0
}

/** Purge des tentatives antérieures à `before`, par lots bornés. */
export async function purgeRateLimitHits(
  db: Db,
  input: { before: number; limit?: number },
): Promise<number> {
  const limit = clampLimit(input.limit, 500, 2000)

  try {
    const result = await db
      .prepare(
        `DELETE FROM rate_limit_hits
          WHERE id IN (
            SELECT id FROM rate_limit_hits
             WHERE created_at <= ?1
             ORDER BY created_at
             LIMIT ?2
          )`,
      )
      .bind(input.before, limit)
      .run()

    return changedRows(result)
  } catch (error) {
    throw toDbError(error)
  }
}
