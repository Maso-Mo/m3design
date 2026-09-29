/**
 * Vérification des fondations : le schéma du dépôt s'applique bien à une vraie base
 * D1 locale, et les garanties sur lesquelles reposent les dépôts sont réelles.
 *
 * Ces tests ne testent pas du code applicatif : ils testent les hypothèses
 * documentées dans les commentaires des dépôts (atomicité d'un lot, clés
 * étrangères actives, dates en secondes Unix, absence de transactions
 * interactives). Si l'une d'elles se révélait fausse, les garanties « tout ou
 * rien » des écritures seraient à revoir, d'où l'intérêt de les vérifier ici.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyMigrations,
  createTestDatabase,
  type TestDatabase,
} from './helpers/database'

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.dispose()
})

describe('base D1 locale et migrations', () => {
  it('crée toutes les tables du schéma', async () => {
    const result = await database.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            AND name NOT LIKE '\\_%' ESCAPE '\\'
            AND name <> 'd1_migrations'
          ORDER BY name`,
      )
      .all<{ name: string }>()

    // Depuis la V1, `otp_challenges` n'existe plus : la vérification par code a été
    // abandonnée avec WhatsApp (migration 0008).
    expect(result.results?.map((row) => row.name)).toEqual([
      'audit_log',
      'contact_messages',
      'email_outbox',
      'quote_requests',
      'rate_limit_hits',
      'request_events',
      'sessions',
      'users',
    ])
  })

  it('ne conserve AUCUN déclencheur de vérification', async () => {
    // Les quatre déclencheurs qui exigeaient une preuve de numéro ont été retirés par
    // la migration 0008 : plus aucun code n'alimente `otp_challenges`.
    const result = await database.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
      )
      .all<{ name: string }>()

    const names = result.results?.map((row) => row.name) ?? []
    expect(names.filter((name) => name.includes('verification'))).toEqual([])
  })

  it('ne réapplique rien lors d’une seconde exécution', () => {
    expect(applyMigrations(database.persistDir)).toMatch(
      /no migrations to apply/i,
    )
  })

  it('applique les clés étrangères', async () => {
    await expect(
      database.db
        .prepare(
          `INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
           VALUES (999, '${'a'.repeat(64)}', 1800000000, 1800003600)`,
        )
        .run(),
    ).rejects.toThrow()
  })

  it('exécute un lot de façon atomique : tout ou rien', async () => {
    await expect(
      database.db.batch([
        database.db.prepare(
          `INSERT INTO audit_log (occurred_at, action, entity_type, outcome)
             VALUES (1800000000, 'test.batch', 'system', 'success')`,
        ),
        // Échec volontaire : la clé étrangère ne correspond à aucun compte.
        database.db.prepare(
          `INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
           VALUES (999, '${'b'.repeat(64)}', 1800000000, 1800003600)`,
        ),
      ]),
    ).rejects.toThrow()

    const result = await database.db
      .prepare(`SELECT COUNT(*) AS total FROM audit_log`)
      .first<{ total: number }>()
    expect(result?.total).toBe(0)
  })

  it('refuse les transactions interactives (BEGIN)', async () => {
    await expect(database.db.prepare('BEGIN').run()).rejects.toThrow()
  })

  it('horodate en secondes Unix entières', async () => {
    const result = await database.db
      .prepare(`SELECT unixepoch() AS maintenant, typeof(unixepoch()) AS genre`)
      .first<{ maintenant: number; genre: string }>()

    expect(result?.genre).toBe('integer')
    expect(result?.maintenant).toBeGreaterThan(1_700_000_000)
    expect(result?.maintenant).toBeLessThan(2_200_000_000)
  })
})
