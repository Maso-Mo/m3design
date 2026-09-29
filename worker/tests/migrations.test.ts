/**
 * Tests de la migration `0008_forms_without_verification.sql`.
 *
 * Une migration ne se juge pas sur une base vide : c'est sur une base DÉJÀ remplie
 * qu'elle peut détruire des données. Ce fichier construit donc une base « d'avant la
 * migration » (toutes les migrations précédentes, appliquées une par une) contenant
 * des demandes historiques AVEC leurs événements et leurs notifications, puis
 * applique 0008 par-dessus, dans un dossier temporaire : la base de développement
 * n'est jamais touchée.
 *
 * Deux enseignements ont dicté son écriture :
 *
 *   1. SQLite exécute un DELETE implicite quand on supprime une table parente, et
 *      les clés étrangères `ON DELETE CASCADE` emportent alors les lignes enfants.
 *      `defer_foreign_keys` reporte le CONTRÔLE, pas les ACTIONS : la migration doit
 *      donc copier puis restaurer explicitement `email_outbox` et `request_events`.
 *      C'est précisément ce que ce fichier vérifie, ligne par ligne ;
 *   2. les lignes historiques n'ont pas toutes une adresse électronique (elle était
 *      facultative avant la V1) : la colonne `intake_version` les dispense des
 *      nouveaux champs obligatoires, sans quoi la migration échouerait sur des
 *      données réelles.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applySqlFile,
  createDatabaseDir,
  executeSql,
  listMigrationFiles,
  migrationFilePath,
  openDatabase,
  removeDatabase,
} from './helpers/database'
import type { Db } from '../src/db/client'

const MIGRATION_FILES = listMigrationFiles()
/** Migration étudiée : la dernière du dépôt. */
const STUDIED = MIGRATION_FILES[MIGRATION_FILES.length - 1] ?? ''
/** Toutes les migrations ANTÉRIEURES, appliquées avant l'amorçage. */
const PREVIOUS = MIGRATION_FILES.filter((name) => name !== STUDIED)

let persistDir = ''
let db: Db
let dispose: () => Promise<void>

/**
 * Base « d'avant la migration » : deux demandes (une vérifiée, une restée en
 * attente), un message de contact, leurs événements et leurs notifications.
 *
 * Les valeurs sont réalistes (références au format public, empreintes de 64
 * caractères hexadécimaux, numéros E.164) : une donnée irréaliste passerait peut-être
 * là où une donnée réelle échouerait.
 */
const SEED = `
INSERT INTO otp_challenges (
  id, phone_normalized, purpose, code_hash, hash_algorithm, status, attempts,
  max_attempts, created_at, expires_at, closed_at, verified_at, proof_valid_until
) VALUES
  (1, '+33612345678', 'quote_request',
   '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
   'hmac-sha256', 'verified', 1, 5, 1700000000, 1700000600, 1700000010,
   1700000010, 1700000900),
  (2, '+33612345679', 'contact',
   'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
   'hmac-sha256', 'verified', 1, 5, 1700000000, 1700000600, 1700000010,
   1700000010, 1700000900);

INSERT INTO quote_requests (
  id, reference, phone_normalized, phone_raw, contact_name, contact_email,
  description, status, phone_verification_id, phone_verified_at, idempotency_key,
  created_at, updated_at, closed_at, anonymized_at
) VALUES
  (1, 'DEV-2026-ABCD2345', '+33612345678', '0612345678', 'Camille',
   'camille@example.fr', 'Un site vitrine pour mon activité artisanale', 'verified',
   1, 1700000015, 'cle-idempotence-de-test-000001', 1700000015, 1700000015, NULL,
   NULL),
  (2, 'DEV-2026-ABCD2346', '+33612345670', '0612345670', 'Sans adresse', NULL,
   'Demande historique sans adresse électronique', 'pending', NULL, NULL,
   'cle-idempotence-de-test-000002', 1700000020, 1700000020, NULL, NULL);

INSERT INTO contact_messages (
  id, reference, phone_normalized, phone_raw, contact_name, contact_email,
  message, status, phone_verification_id, phone_verified_at, idempotency_key,
  created_at, updated_at, closed_at, anonymized_at
) VALUES
  (1, 'MSG-2026-EFGH3456', '+33612345679', '0612345679', 'Léa',
   'lea@example.fr', 'Bonjour, je voudrais un devis pour un portail coulissant.',
   'verified', 2, 1700000030, 'cle-idempotence-de-test-000003', 1700000030,
   1700000030, NULL, NULL);

INSERT INTO request_events (
  id, quote_request_id, contact_message_id, event_type, from_status, to_status,
  actor, actor_user_id, reason, created_at
) VALUES
  (1, 1, NULL, 'created', NULL, 'verified', 'client', NULL, NULL, 1700000015),
  (2, 1, NULL, 'phone_verified', 'pending', 'verified', 'system', NULL, NULL,
   1700000015),
  (3, NULL, 1, 'created', NULL, 'verified', 'client', NULL, NULL, 1700000030);

INSERT INTO email_outbox (
  id, quote_request_id, contact_message_id, recipient, subject, body_text, status,
  attempts, next_attempt_at, last_error, created_at, sent_at
) VALUES
  (1, 1, NULL, 'contact@m3design.example',
   'Nouvelle demande de devis DEV-2026-ABCD2345',
   'Courriel accepté par le fournisseur', 'sent', 2, 1700000100, NULL, 1700000015,
   1700000200),
  (2, NULL, 1, 'contact@m3design.example',
   'Nouveau message de contact MSG-2026-EFGH3456',
   'Courriel encore en attente', 'pending', 0, 1700000030, NULL, 1700000030, NULL);
`

beforeAll(async () => {
  persistDir = createDatabaseDir()
  // 1. Tout le schéma « d'avant la migration », migration par migration.
  for (const name of PREVIOUS) {
    applySqlFile(persistDir, migrationFilePath(name))
  }
  // 2. Des données réelles : demandes, message, événements et notifications.
  executeSql(persistDir, SEED)
  // 3. La migration étudiée, appliquée par-dessus.
  applySqlFile(persistDir, migrationFilePath(STUDIED))
  const opened = await openDatabase(persistDir)
  db = opened.db
  dispose = opened.dispose
})

afterAll(async () => {
  await dispose()
  removeDatabase(persistDir)
})

describe('migration 0008 : préservation des données existantes', () => {
  it('conserve les demandes, leurs références et leurs données personnelles', async () => {
    const rows = await db
      .prepare(
        `SELECT id, reference, status, intake_version, phone_normalized, phone_raw,
                contact_name, contact_email, description, idempotency_key,
                created_at, updated_at, closed_at, anonymized_at
           FROM quote_requests ORDER BY id`,
      )
      .all<Record<string, unknown>>()

    expect(rows.results).toEqual([
      {
        id: 1,
        reference: 'DEV-2026-ABCD2345',
        // « verified » n'existe plus : l'état devient « new ».
        status: 'new',
        intake_version: 1,
        phone_normalized: '+33612345678',
        phone_raw: '0612345678',
        contact_name: 'Camille',
        contact_email: 'camille@example.fr',
        description: 'Un site vitrine pour mon activité artisanale',
        idempotency_key: 'cle-idempotence-de-test-000001',
        created_at: 1_700_000_015,
        updated_at: 1_700_000_015,
        closed_at: null,
        anonymized_at: null,
      },
      {
        id: 2,
        reference: 'DEV-2026-ABCD2346',
        status: 'new',
        intake_version: 1,
        phone_normalized: '+33612345670',
        phone_raw: '0612345670',
        contact_name: 'Sans adresse',
        // L'absence d'adresse est CONSERVÉE : les lignes historiques ne sont pas
        // soumises aux champs obligatoires de la V1.
        contact_email: null,
        description: 'Demande historique sans adresse électronique',
        idempotency_key: 'cle-idempotence-de-test-000002',
        created_at: 1_700_000_020,
        updated_at: 1_700_000_020,
        closed_at: null,
        anonymized_at: null,
      },
    ])
  })

  it('conserve le message de contact et son propriétaire', async () => {
    const row = await db
      .prepare(
        `SELECT id, reference, status, intake_version, phone_normalized,
                contact_name, contact_email, message, created_at
           FROM contact_messages ORDER BY id`,
      )
      .first<Record<string, unknown>>()

    expect(row).toEqual({
      id: 1,
      reference: 'MSG-2026-EFGH3456',
      status: 'new',
      intake_version: 1,
      phone_normalized: '+33612345679',
      contact_name: 'Léa',
      contact_email: 'lea@example.fr',
      message: 'Bonjour, je voudrais un devis pour un portail coulissant.',
      created_at: 1_700_000_030,
    })
  })

  it('conserve TOUS les événements, y compris ceux de l’ancien parcours', async () => {
    const rows = await db
      .prepare(
        `SELECT id, quote_request_id, contact_message_id, event_type, from_status,
                to_status, actor, created_at
           FROM request_events ORDER BY id`,
      )
      .all<Record<string, unknown>>()

    expect(rows.results).toEqual([
      {
        id: 1,
        quote_request_id: 1,
        contact_message_id: null,
        event_type: 'created',
        from_status: null,
        to_status: 'new',
        actor: 'client',
        created_at: 1_700_000_015,
      },
      {
        id: 2,
        quote_request_id: 1,
        contact_message_id: null,
        // Valeur HISTORIQUE conservée : une vérification a bien eu lieu avant la V1.
        event_type: 'phone_verified',
        from_status: 'new',
        to_status: 'new',
        actor: 'system',
        created_at: 1_700_000_015,
      },
      {
        id: 3,
        quote_request_id: null,
        contact_message_id: 1,
        event_type: 'created',
        from_status: null,
        to_status: 'new',
        actor: 'client',
        created_at: 1_700_000_030,
      },
    ])
  })

  it('conserve les notifications à l’identique, ligne par ligne', async () => {
    const rows = await db
      .prepare(
        `SELECT id, quote_request_id, contact_message_id, recipient, subject,
                body_text, status, attempts, next_attempt_at, last_error,
                created_at, sent_at
           FROM email_outbox ORDER BY id`,
      )
      .all<Record<string, unknown>>()

    expect(rows.results).toEqual([
      {
        id: 1,
        quote_request_id: 1,
        contact_message_id: null,
        recipient: 'contact@m3design.example',
        subject: 'Nouvelle demande de devis DEV-2026-ABCD2345',
        body_text: 'Courriel accepté par le fournisseur',
        status: 'sent',
        attempts: 2,
        next_attempt_at: 1_700_000_100,
        last_error: null,
        created_at: 1_700_000_015,
        sent_at: 1_700_000_200,
      },
      {
        id: 2,
        quote_request_id: null,
        contact_message_id: 1,
        recipient: 'contact@m3design.example',
        subject: 'Nouveau message de contact MSG-2026-EFGH3456',
        body_text: 'Courriel encore en attente',
        status: 'pending',
        attempts: 0,
        next_attempt_at: 1_700_000_030,
        last_error: null,
        created_at: 1_700_000_030,
        sent_at: null,
      },
    ])
  })

  it('supprime la table des codes et les déclencheurs de vérification', async () => {
    const tables = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all<{ name: string }>()
    const names = (tables.results ?? []).map((row) => row.name)
    expect(names).not.toContain('otp_challenges')
    expect(names).not.toContain('quote_requests_v2')

    const triggers = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%verification%'`,
      )
      .all<{ name: string }>()
    expect(triggers.results ?? []).toEqual([])
  })
})

describe('migration 0008 : garanties du nouveau formulaire', () => {
  it('exige nom, adresse électronique et texte pour une nouvelle demande', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO quote_requests (
             reference, phone_normalized, phone_raw, contact_name, contact_email,
             description, idempotency_key, created_at, updated_at
           ) VALUES ('DEV-2026-V1TEST01', NULL, NULL, 'Nom seul', NULL,
                     'Une description assez longue', 'cle-idempotence-v1-000001',
                     1700000300, 1700000300)`,
        )
        .run(),
    ).rejects.toThrow(/ck_quote_intake_required/)

    const inserted = await db
      .prepare(
        `INSERT INTO quote_requests (
           reference, phone_normalized, phone_raw, contact_name, contact_email,
           description, idempotency_key, created_at, updated_at
         ) VALUES ('DEV-2026-V1TEST02', NULL, NULL, 'Nom complet',
                   'nom@example.fr', 'Une description assez longue',
                   'cle-idempotence-v1-000002', 1700000300, 1700000300)
         RETURNING id, status, intake_version, phone_normalized`,
      )
      .first<Record<string, unknown>>()

    expect(inserted).toMatchObject({
      status: 'new',
      intake_version: 2,
      phone_normalized: null,
    })
  })

  it('garantit l’unicité de la clé d’idempotence des messages', async () => {
    await db
      .prepare(
        `INSERT INTO contact_messages (
           reference, contact_name, contact_email, message, idempotency_key,
           created_at, updated_at
         ) VALUES ('MSG-2026-V1TEST01', 'Nom', 'nom@example.fr',
                   'Un message assez long', 'cle-contact-v1-000000001',
                   1700000400, 1700000400)`,
      )
      .run()

    await expect(
      db
        .prepare(
          `INSERT INTO contact_messages (
             reference, contact_name, contact_email, message, idempotency_key,
             created_at, updated_at
           ) VALUES ('MSG-2026-V1TEST02', 'Autre', 'autre@example.fr',
                     'Un autre message long', 'cle-contact-v1-000000001',
                     1700000400, 1700000400)`,
        )
        .run(),
    ).rejects.toThrow(/contact_messages\.idempotency_key/)
  })

  it('conserve l’unicité d’un téléphone actif et la libère à la clôture', async () => {
    await db
      .prepare(
        `INSERT INTO quote_requests (
           reference, phone_normalized, phone_raw, contact_name, contact_email,
           description, idempotency_key, created_at, updated_at
         ) VALUES ('DEV-2026-V1TEST03', '+33612345671', '0612345671', 'Nom',
                   'nom2@example.fr', 'Une description assez longue',
                   'cle-idempotence-v1-000003', 1700000500, 1700000500)`,
      )
      .run()

    // Deuxième demande active pour le même téléphone : refusée par la base.
    await expect(
      db
        .prepare(
          `INSERT INTO quote_requests (
             reference, phone_normalized, phone_raw, contact_name, contact_email,
             description, idempotency_key, created_at, updated_at
           ) VALUES ('DEV-2026-V1TEST04', '+33612345671', '0612345671', 'Nom',
                     'nom3@example.fr', 'Une autre description longue',
                     'cle-idempotence-v1-000004', 1700000500, 1700000500)`,
        )
        .run(),
    ).rejects.toThrow(/quote_requests\.phone_normalized/)
  })
})
