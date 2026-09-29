/**
 * Tests d'intégration des comptes administratifs et de leurs sessions.
 *
 * Ce qui est vérifié ici tient aux garanties du schéma et au comportement attendu
 * d'un accès d'administration : une adresse de connexion unique et normalisée, une
 * empreinte de mot de passe toujours stockée sous forme d'empreinte, un verrouillage
 * progressif après des échecs répétés, une désactivation qui coupe l'accès
 * immédiatement (sessions révoquées dans la même opération), des jetons de session
 * jamais stockés en clair, et une purge des sessions révoquées.
 *
 * Les valeurs sont fictives, les dates fixes, et aucun accès réseau n'est effectué.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAdminSession,
  findActiveAdminSession,
  purgeAdminSessions,
  revokeAdminSession,
  revokeAdminUserSessions,
  touchAdminSession,
} from '../src/db/repositories/sessions'
import {
  createAdminUser,
  findAdminUserByEmail,
  findAdminUserById,
  recordFailedAdminLogin,
  recordSuccessfulAdminLogin,
  setAdminUserStatus,
  type AdminUserRow,
} from '../src/db/repositories/users'
import { createTestDatabase, type TestDatabase } from './helpers/database'

/** Instant de référence : 2027-01-15T08:00:00Z. */
const NOW = 1_800_000_000
const TTL = 3_600
/** Empreinte de mot de passe factice, au format modulaire attendu. */
const PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$c2VsZGV0ZXN0c2Vs$empreintefictivepourtests'

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.dispose()
})

let accountSequence = 0

/** Crée un compte de test avec une adresse unique et fictive. */
async function createAccount(email?: string, now = NOW): Promise<AdminUserRow> {
  accountSequence += 1
  return createAdminUser(database.db, {
    email: email ?? `admin${accountSequence}@m3design.test`,
    displayName: `Administration ${accountSequence}`,
    passwordHash: PASSWORD_HASH,
    now,
  })
}

/** Empreinte SHA-256 factice : 64 caractères hexadécimaux, un jeton jamais en clair. */
function tokenHash(seed: string): string {
  return seed.repeat(64).slice(0, 64)
}

describe('comptes administratifs', () => {
  it('crée un compte actif et normalise l’adresse de connexion', async () => {
    const created = await createAccount('  Admin.Normalise@M3Design.Test  ')

    expect(created.email).toBe('admin.normalise@m3design.test')
    expect(created.display_name).toBe(`Administration ${accountSequence}`)
    expect(created.status).toBe('active')
    expect(created.failed_login_count).toBe(0)
    expect(created.locked_until).toBeNull()
    expect(created.last_login_at).toBeNull()
    // Le second facteur reste inutilisé : aucune valeur n'est écrite par défaut.
    expect(created.totp_secret_encrypted).toBeNull()
    // L'empreinte est stockée telle quelle : jamais un mot de passe en clair.
    expect(created.password_hash).toBe(PASSWORD_HASH)

    const found = await findAdminUserByEmail(
      database.db,
      'ADMIN.NORMALISE@M3DESIGN.TEST',
    )
    expect(found?.id).toBe(created.id)
    expect(await findAdminUserById(database.db, created.id)).toMatchObject({
      id: created.id,
    })
    expect(await findAdminUserById(database.db, 999_999)).toBeNull()
  })

  it('refuse une empreinte qui n’en est pas une, avant toute écriture', async () => {
    await expect(
      createAdminUser(database.db, {
        email: 'motdepasse.en.clair@m3design.test',
        displayName: 'Administration',
        passwordHash: 'motdepasse-en-clair',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_password_hash' })

    // Rien n'a été écrit : l'adresse reste libre.
    expect(
      await findAdminUserByEmail(
        database.db,
        'motdepasse.en.clair@m3design.test',
      ),
    ).toBeNull()
  })

  it('refuse deux comptes pour la même adresse et une adresse invalide', async () => {
    const account = await createAccount()

    await expect(
      createAdminUser(database.db, {
        email: account.email.toUpperCase(),
        displayName: 'Doublon',
        passwordHash: PASSWORD_HASH,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(
      createAdminUser(database.db, {
        email: 'adresse-sans-arobase',
        displayName: 'Adresse invalide',
        passwordHash: PASSWORD_HASH,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('verrouillage des connexions', () => {
  it('verrouille le compte au seuil d’échecs, puis le libère à la première connexion réussie', async () => {
    const account = await createAccount()

    expect(
      await recordFailedAdminLogin(database.db, {
        userId: account.id,
        lockAfterFailures: 3,
        lockSeconds: 900,
        now: NOW + 10,
      }),
    ).toEqual({ failedLoginCount: 1, lockedUntil: null })

    expect(
      await recordFailedAdminLogin(database.db, {
        userId: account.id,
        lockAfterFailures: 3,
        lockSeconds: 900,
        now: NOW + 20,
      }),
    ).toEqual({ failedLoginCount: 2, lockedUntil: null })

    // Au troisième échec, le compte est verrouillé pour la durée demandée (900 s).
    expect(
      await recordFailedAdminLogin(database.db, {
        userId: account.id,
        lockAfterFailures: 3,
        lockSeconds: 900,
        now: NOW + 30,
      }),
    ).toEqual({ failedLoginCount: 3, lockedUntil: NOW + 930 })

    const locked = await findAdminUserById(database.db, account.id)
    expect(locked?.locked_until).toBe(NOW + 930)

    const success = await recordSuccessfulAdminLogin(database.db, {
      userId: account.id,
      now: NOW + 40,
    })
    expect(success).toMatchObject({
      failed_login_count: 0,
      locked_until: null,
      last_login_at: NOW + 40,
    })
  })

  it('ignore les échecs d’un compte inconnu ou désactivé', async () => {
    const account = await createAccount()
    await setAdminUserStatus(database.db, {
      userId: account.id,
      status: 'disabled',
      now: NOW + 50,
    })

    expect(
      await recordFailedAdminLogin(database.db, {
        userId: account.id,
        lockAfterFailures: 3,
        lockSeconds: 900,
        now: NOW + 60,
      }),
    ).toBeNull()
    expect(
      await recordFailedAdminLogin(database.db, {
        userId: 999_999,
        lockAfterFailures: 3,
        lockSeconds: 900,
        now: NOW + 60,
      }),
    ).toBeNull()
    expect(
      await recordSuccessfulAdminLogin(database.db, {
        userId: 999_999,
        now: NOW + 60,
      }),
    ).toBeNull()
  })

  it('renvoie null pour un compte inconnu à la désactivation', async () => {
    expect(
      await setAdminUserStatus(database.db, {
        userId: 999_999,
        status: 'disabled',
        now: NOW,
      }),
    ).toBeNull()
  })
})

describe('désactivation et sessions', () => {
  it('révoque immédiatement les sessions actives du compte désactivé, sans toucher aux autres', async () => {
    const account = await createAccount()
    const other = await createAccount()

    const active = await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('a'),
      ttlSeconds: TTL,
      now: NOW,
    })
    const expired = await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('b'),
      ttlSeconds: 1,
      now: NOW - 100,
    })
    const otherSession = await createAdminSession(database.db, {
      userId: other.id,
      tokenHash: tokenHash('c'),
      ttlSeconds: TTL,
      now: NOW,
    })

    const disabled = await setAdminUserStatus(database.db, {
      userId: account.id,
      status: 'disabled',
      now: NOW + 70,
    })
    expect(disabled?.status).toBe('disabled')

    // La révocation fait partie de la même opération : aucun jeton encore valable.
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('a'),
        now: NOW + 71,
      }),
    ).toBeNull()
    const revoked = await database.db
      .prepare(`SELECT revoked_at FROM sessions WHERE id = ?1`)
      .bind(active.id)
      .first<{ revoked_at: number | null }>()
    expect(revoked?.revoked_at).toBe(NOW + 70)

    // Une session déjà expirée n'est pas marquée révoquée : elle l'était de fait.
    const expiredRow = await database.db
      .prepare(`SELECT revoked_at FROM sessions WHERE id = ?1`)
      .bind(expired.id)
      .first<{ revoked_at: number | null }>()
    expect(expiredRow?.revoked_at).toBeNull()

    // Les autres comptes restent opérationnels.
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('c'),
        now: NOW + 71,
      }),
    ).toMatchObject({ session_id: otherSession.id, user_status: 'active' })

    // Réactiver le compte ne ressuscite pas la session révoquée.
    const reactivated = await setAdminUserStatus(database.db, {
      userId: account.id,
      status: 'active',
      now: NOW + 80,
    })
    expect(reactivated?.status).toBe('active')
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('a'),
        now: NOW + 81,
      }),
    ).toBeNull()
  })

  it('refuse un jeton de session qui n’est pas une empreinte SHA-256', async () => {
    const account = await createAccount()

    await expect(
      createAdminSession(database.db, {
        userId: account.id,
        tokenHash: 'jeton-en-clair',
        ttlSeconds: TTL,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(
      findActiveAdminSession(database.db, {
        tokenHash: 'jeton-en-clair',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('n’ouvre pas de session pour un compte inconnu', async () => {
    await expect(
      createAdminSession(database.db, {
        userId: 999_999,
        tokenHash: tokenHash('d'),
        ttlSeconds: TTL,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('cycle de vie des sessions', () => {
  it('ne retrouve ni une session révoquée ni une session expirée', async () => {
    const account = await createAccount()

    const session = await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('e'),
      ttlSeconds: TTL,
      now: NOW,
    })
    expect(session.expires_at).toBe(NOW + TTL)

    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('e'),
        now: NOW,
      }),
    ).toMatchObject({
      session_id: session.id,
      user_id: account.id,
      user_email: account.email,
      user_status: 'active',
    })

    expect(
      await revokeAdminSession(database.db, {
        tokenHash: tokenHash('e'),
        now: NOW + 10,
      }),
    ).toBe(true)
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('e'),
        now: NOW + 11,
      }),
    ).toBeNull()
    // Révoquer deux fois la même session ne fait rien de plus.
    expect(
      await revokeAdminSession(database.db, {
        tokenHash: tokenHash('e'),
        now: NOW + 12,
      }),
    ).toBe(false)

    // Expiration : la session n'est plus active, sans révocation explicite.
    const shortLived = await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('f'),
      ttlSeconds: 60,
      now: NOW,
    })
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('f'),
        now: NOW + 59,
      }),
    ).toMatchObject({ session_id: shortLived.id })
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('f'),
        now: NOW + 60,
      }),
    ).toBeNull()
  })

  it('met à jour la dernière activité sans prolonger la session', async () => {
    const account = await createAccount()
    const session = await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('1'),
      ttlSeconds: TTL,
      now: NOW,
    })
    expect(session.last_seen_at).toBeNull()

    expect(
      await touchAdminSession(database.db, {
        sessionId: session.id,
        now: NOW + 120,
      }),
    ).toBe(true)

    const touched = await database.db
      .prepare(`SELECT last_seen_at, expires_at FROM sessions WHERE id = ?1`)
      .bind(session.id)
      .first<{ last_seen_at: number | null; expires_at: number }>()
    expect(touched?.last_seen_at).toBe(NOW + 120)
    // L'activité ne repousse jamais l'expiration : seule la durée initiale décide.
    expect(touched?.expires_at).toBe(NOW + TTL)

    expect(
      await touchAdminSession(database.db, {
        sessionId: 999_999,
        now: NOW + 130,
      }),
    ).toBe(false)
  })
})

describe('révocation et purge', () => {
  it('révoque toutes les sessions d’un compte sauf celle en cours', async () => {
    const account = await createAccount()
    const kept = await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('2'),
      ttlSeconds: TTL,
      now: NOW,
    })
    await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('3'),
      ttlSeconds: TTL,
      now: NOW,
    })
    const other = await createAccount()
    await createAdminSession(database.db, {
      userId: other.id,
      tokenHash: tokenHash('4'),
      ttlSeconds: TTL,
      now: NOW,
    })

    expect(
      await revokeAdminUserSessions(database.db, {
        userId: account.id,
        exceptSessionId: kept.id,
        now: NOW + 200,
      }),
    ).toBe(1)

    // La session en cours survit, l'autre est coupée, les autres comptes intacts.
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('2'),
        now: NOW + 201,
      }),
    ).toMatchObject({ session_id: kept.id })
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('3'),
        now: NOW + 201,
      }),
    ).toBeNull()
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('4'),
        now: NOW + 201,
      }),
    ).not.toBeNull()

    // Sans exception, toutes les sessions du compte y passent.
    expect(
      await revokeAdminUserSessions(database.db, {
        userId: account.id,
        now: NOW + 210,
      }),
    ).toBe(1)
    expect(
      await findActiveAdminSession(database.db, {
        tokenHash: tokenHash('2'),
        now: NOW + 211,
      }),
    ).toBeNull()
  })

  it('purge les sessions révoquées ou expirées, jamais les sessions actives', async () => {
    const account = await createAccount()
    const old = await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('5'),
      ttlSeconds: TTL,
      now: NOW,
    })
    const recent = await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('6'),
      ttlSeconds: TTL,
      now: NOW,
    })
    const stillActive = await createAdminSession(database.db, {
      userId: account.id,
      tokenHash: tokenHash('7'),
      ttlSeconds: TTL,
      now: NOW,
    })

    await revokeAdminSession(database.db, {
      tokenHash: tokenHash('5'),
      now: NOW + 300,
    })
    await revokeAdminSession(database.db, {
      tokenHash: tokenHash('6'),
      now: NOW + 700,
    })

    const purged = await purgeAdminSessions(database.db, {
      revokedBefore: NOW + 500,
      now: NOW + 800,
    })
    expect(purged).toBeGreaterThanOrEqual(1)

    const remaining = await database.db
      .prepare(`SELECT id FROM sessions ORDER BY id`)
      .all<{ id: number }>()
    const ids = (remaining.results ?? []).map((row) => row.id)
    // Révocation ancienne : la ligne disparaît.
    expect(ids).not.toContain(old.id)
    // Révocation plus récente que la date demandée : conservée pour l'enquête.
    expect(ids).toContain(recent.id)
    // Session encore active : jamais purgée.
    expect(ids).toContain(stillActive.id)
  })
})
