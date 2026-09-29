/**
 * Dépôt des comptes administratifs.
 *
 * Périmètre volontairement limité : ce module ne vérifie AUCUN mot de passe et ne
 * crée AUCUNE session. Il constate des faits (échec ou réussite de connexion
 * décidés par la couche service, qui seule détient la fonction de dérivation de
 * mot de passe) et maintient les compteurs de protection et l'état des comptes.
 *
 * Règles portées par le schéma et respectées ici :
 *   * un mot de passe n'est jamais stocké : seule une empreinte au format reconnu
 *     (chaîne modulaire commençant par « $ ») est acceptée ; la vérification de
 *     forme est faite avant l'écriture, pour produire une erreur claire ;
 *   * un compte n'est jamais supprimé, mais désactivé, afin que l'historique des
 *     demandes et le journal d'audit restent attribuables ;
 *   * la désactivation d'un compte révoque ses sessions dans la même transaction :
 *     un compte désactivé ne peut pas rester connecté.
 */

import { nowSeconds, type Db } from '../client'
import { DbError, toDbError } from '../errors'

/** États d'un compte, alignés sur `ck_users_status`. */
export type AdminUserStatus = 'active' | 'disabled'

/** Ligne de `users` telle que renvoyée par la base. */
export type AdminUserRow = {
  id: number
  email: string
  display_name: string
  password_hash: string
  totp_secret_encrypted: string | null
  status: AdminUserStatus
  failed_login_count: number
  locked_until: number | null
  last_login_at: number | null
  created_at: number
  updated_at: number
}

/** Colonnes renvoyées par toute lecture de compte. */
const COLUMNS = `id, email, display_name, password_hash, totp_secret_encrypted, status,
  failed_login_count, locked_until, last_login_at, created_at, updated_at`

/**
 * Contrôle de forme d'une empreinte de mot de passe, avant écriture.
 *
 * Aucune empreinte n'est calculée ici : la production de l'empreinte (et donc le
 * choix de l'algorithme) appartient à la couche service. Ce contrôle évite
 * simplement d'écrire une valeur qui ne serait pas une empreinte — un mot de passe
 * en clair, par exemple — pour que l'erreur soit explicite côté serveur.
 */
export function assertPasswordHashFormat(passwordHash: string): void {
  const looksLikeModularHash =
    passwordHash.startsWith('$') && passwordHash.split('$').length >= 4
  if (
    !looksLikeModularHash ||
    passwordHash.length < 20 ||
    passwordHash.length > 255
  ) {
    throw new DbError('invalid_password_hash')
  }
}

/** Adresse de connexion normalisée : espaces retirés, minuscules forcées. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Crée un compte administratif (aucun jeton, aucune session). */
export async function createAdminUser(
  db: Db,
  input: {
    email: string
    displayName: string
    passwordHash: string
    now?: number
  },
): Promise<AdminUserRow> {
  assertPasswordHashFormat(input.passwordHash)
  const now = input.now ?? nowSeconds()

  try {
    const created = await db
      .prepare(
        `INSERT INTO users (email, display_name, password_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         RETURNING ${COLUMNS}`,
      )
      .bind(
        normalizeEmail(input.email),
        input.displayName.trim(),
        input.passwordHash,
        now,
      )
      .first<AdminUserRow>()

    if (!created) {
      throw new DbError('db_unavailable')
    }
    return created
  } catch (error) {
    throw toDbError(error)
  }
}

/** Lecture d'un compte par adresse de connexion. */
export async function findAdminUserByEmail(
  db: Db,
  email: string,
): Promise<AdminUserRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM users WHERE email = ?1`)
    .bind(normalizeEmail(email))
    .first<AdminUserRow>()
  return row ?? null
}

/** Lecture d'un compte par identifiant interne. */
export async function findAdminUserById(
  db: Db,
  userId: number,
): Promise<AdminUserRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?1`)
    .bind(userId)
    .first<AdminUserRow>()
  return row ?? null
}

/**
 * Active ou désactive un compte.
 *
 * Renvoie `null` si l'identifiant est inconnu. Un compte désactivé voit toutes ses
 * sessions révoquées dans la même transaction : c'est ce qui rend la désactivation
 * immédiatement effective, sans attendre l'expiration des jetons en circulation.
 */
export async function setAdminUserStatus(
  db: Db,
  input: { userId: number; status: AdminUserStatus; now?: number },
): Promise<AdminUserRow | null> {
  const now = input.now ?? nowSeconds()

  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users
              SET status = ?2, updated_at = ?3
            WHERE id = ?1
            RETURNING ${COLUMNS}`,
        )
        .bind(input.userId, input.status, now),
      // Un compte désactivé ne doit pas conserver de session active : la
      // révocation est dans la même transaction que la désactivation.
      db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?2
            WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
        )
        .bind(input.userId, now),
    ])

    const updated = results[0]?.results?.[0] as AdminUserRow | undefined
    return updated ?? null
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Enregistre un échec de connexion et verrouille temporairement le compte au-delà
 * du seuil fourni par la couche service.
 *
 * Le compteur et le verrouillage sont calculés en SQL à partir de la valeur
 * courante : deux tentatives simultanées ne peuvent pas se « perdre » l'une
 * l'autre. La politique (seuil, durée) est transmise par l'appelant et jamais
 * fixée ici, afin de rester ajustable par configuration.
 *
 * Renvoie `null` si aucun compte actif ne correspond à l'identifiant : la couche
 * service renvoie alors la même réponse neutre qu'un mot de passe erroné.
 */
export async function recordFailedAdminLogin(
  db: Db,
  input: {
    userId: number
    lockAfterFailures: number
    lockSeconds: number
    now?: number
  },
): Promise<{ failedLoginCount: number; lockedUntil: number | null } | null> {
  const now = input.now ?? nowSeconds()
  const threshold = Math.max(Math.floor(input.lockAfterFailures), 1)
  const lockedUntil = now + Math.max(Math.floor(input.lockSeconds), 1)

  try {
    const updated = await db
      .prepare(
        `UPDATE users
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= ?2 THEN ?4 ELSE locked_until END,
                updated_at = ?3
          WHERE id = ?1 AND status = 'active'
          RETURNING failed_login_count, locked_until`,
      )
      .bind(input.userId, threshold, now, lockedUntil)
      .first<{ failed_login_count: number; locked_until: number | null }>()

    if (!updated) {
      return null
    }
    return {
      failedLoginCount: updated.failed_login_count,
      lockedUntil: updated.locked_until,
    }
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Enregistre une connexion réussie : compteur remis à zéro, verrou levé, date de
 * dernière connexion mise à jour.
 */
export async function recordSuccessfulAdminLogin(
  db: Db,
  input: { userId: number; now?: number },
): Promise<AdminUserRow | null> {
  const now = input.now ?? nowSeconds()

  try {
    const updated = await db
      .prepare(
        `UPDATE users
            SET failed_login_count = 0,
                locked_until = NULL,
                last_login_at = ?2,
                updated_at = ?2
          WHERE id = ?1
          RETURNING ${COLUMNS}`,
      )
      .bind(input.userId, now)
      .first<AdminUserRow>()
    return updated ?? null
  } catch (error) {
    throw toDbError(error)
  }
}
