/**
 * Fabrique de bases de test : une vraie base D1 locale, isolée par fichier de test.
 *
 * Chaque appel crée un dossier temporaire, y applique les migrations du dépôt avec
 * la MÊME commande que celle utilisée en développement (`wrangler d1 migrations
 * apply DB --local`), puis ouvre un accès à la base par `getPlatformProxy`. Les
 * tests s'exécutent ainsi contre le moteur SQLite de workerd, avec ses contraintes,
 * ses déclencheurs et ses index partiels réels — et non contre une imitation.
 *
 * Le dossier temporaire est supprimé à la fin : aucun état ne survit d'une
 * exécution à l'autre, et deux exécutions ne peuvent pas se gêner. Aucun accès
 * réseau, aucun déploiement, aucun secret réel.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPlatformProxy } from 'wrangler'
import type { Db } from '../../src/db/client'

/** Racine du projet (les tests vivent dans worker/tests/helpers/). */
const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
)

/** Exécutable wrangler du projet, appelé explicitement pour ne pas dépendre du PATH. */
const WRANGLER_BIN = join(PROJECT_ROOT, 'node_modules/wrangler/bin/wrangler.js')

/** Nom du binding de base déclaré dans wrangler.jsonc. */
const DATABASE_BINDING = 'DB'

/** Dossier des migrations : appliqué par la commande, lu par les tests. */
const MIGRATIONS_DIR = join(PROJECT_ROOT, 'worker', 'migrations')

/**
 * Exécute wrangler sur la base LOCALE d'un dossier de persistance.
 *
 * Une seule fabrique pour tous les appels : migrations, fichiers SQL de migration
 * et jeux de données passent ainsi par exactement le même chemin (même binaire,
 * même dossier, mêmes options), ce qui évite qu'un test valide une migration par
 * un chemin que la production n'emprunte pas.
 */
function runWrangler(args: string[], failureMessage: string): string {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  })

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) {
    throw new Error(`${failureMessage} :\n${output}`)
  }
  return output
}

/**
 * Liste les fichiers de migration du dépôt, dans l'ordre d'application.
 *
 * Exposé pour que les tests raisonnent sur la MÊME liste que celle appliquée par
 * `wrangler d1 migrations apply` : un fichier ajouté sans être pris en compte par
 * un test de migration ne peut donc pas passer inaperçu.
 */
export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

/** Chemin absolu d'un fichier de migration du dépôt. */
export function migrationFilePath(name: string): string {
  return join(MIGRATIONS_DIR, name)
}

export type TestDatabase = {
  /** Accès à la base, à passer aux dépôts. */
  db: Db
  /** Dossier de persistance temporaire de cette base. */
  persistDir: string
  /** Ferme l'accès et supprime le dossier temporaire. */
  dispose: () => Promise<void>
}

/**
 * Applique les migrations de `worker/migrations` à une base locale.
 *
 * Exposé séparément pour qu'un test puisse vérifier qu'une seconde application ne
 * fait rien (les migrations sont immuables une fois appliquées).
 */
export function applyMigrations(persistDir: string): string {
  return runWrangler(
    [
      'd1',
      'migrations',
      'apply',
      DATABASE_BINDING,
      '--local',
      '--persist-to',
      persistDir,
    ],
    'Application des migrations impossible',
  )
}

/**
 * Applique un fichier SQL (migration ou jeu de données) à une base locale.
 *
 * Sert aux tests de MIGRATION : ils construisent une base « d'avant » en
 * appliquant les fichiers un par un, y insèrent des données réelles, puis
 * appliquent la migration étudiée. C'est le seul moyen de vérifier qu'une
 * migration ne détruit pas les données déjà enregistrées — `migrations apply` ne
 * sait, lui, qu'appliquer la suite complète.
 */
export function applySqlFile(persistDir: string, filePath: string): string {
  return runWrangler(
    [
      'd1',
      'execute',
      DATABASE_BINDING,
      '--local',
      '--persist-to',
      persistDir,
      '--file',
      filePath,
    ],
    `Application du fichier SQL impossible (${filePath})`,
  )
}

/** Applique des instructions SQL écrites en clair (jeu de données de test). */
export function executeSql(persistDir: string, sql: string): string {
  const file = join(persistDir, `instructions-${String(Date.now())}.sql`)
  writeFileSync(file, sql, 'utf8')
  return applySqlFile(persistDir, file)
}

/** Crée un dossier de persistance vide, laissé à la charge de l'appelant. */
export function createDatabaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'm3design-tests-'))
}

/** Supprime un dossier de persistance et tout son contenu. */
export function removeDatabase(persistDir: string): void {
  rmSync(persistDir, { recursive: true, force: true })
}

/**
 * Ouvre l'accès à une base locale existante.
 *
 * Détail de disposition vérifié par les tests : la commande `wrangler d1
 * migrations apply --persist-to <dossier>` range son état dans `<dossier>/v3/`,
 * alors que l'API programmatique `getPlatformProxy` le range directement dans le
 * dossier reçu. Les deux pointent donc ici vers le même état, sinon les tests
 * liraient une base vide. Le test « crée toutes les tables du schéma » échouerait
 * immédiatement si cette disposition changeait.
 *
 * `dispose` ferme l'accès au moteur SANS supprimer le dossier : un test de
 * migration peut ainsi rouvrir la même base après avoir appliqué une autre
 * migration. La suppression du dossier reste explicite (`removeDatabase`).
 */
export async function openDatabase(
  persistDir: string,
): Promise<{ db: Db; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy({
    configPath: join(PROJECT_ROOT, 'wrangler.jsonc'),
    persist: { path: join(persistDir, 'v3') },
  })

  return {
    db: proxy.env[DATABASE_BINDING] as unknown as Db,
    dispose: async () => {
      await proxy.dispose()
    },
  }
}

/** Crée une base de test isolée, migrée et prête à l'emploi. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const persistDir = createDatabaseDir()
  applyMigrations(persistDir)
  const { db, dispose } = await openDatabase(persistDir)

  return {
    db,
    persistDir,
    dispose: async () => {
      await dispose()
      removeDatabase(persistDir)
    },
  }
}

/**
 * Vide les tables opérationnelles d'une base de test.
 *
 * Une base de test est partagée par tous les cas d'un même fichier : sans remise à
 * zéro, un test hérite des compteurs de fenêtre glissante, des challenges et des
 * demandes créés par les tests précédents. L'ordre d'exécution deviendrait alors une
 * dépendance cachée, et un test passerait ou échouerait selon son voisin.
 *
 * L'ordre suit les dépendances de clés étrangères : les lignes filles d'abord, sinon
 * la suppression d'un parent encore référencé échouerait (notifications et
 * événements avant leur demande ou leur message). Les tables d'identité (`users`,
 * `sessions`) ne sont pas touchées : les tests d'API n'y écrivent pas.
 */
export async function clearOperationalTables(db: Db): Promise<void> {
  const tables = [
    'email_outbox',
    'request_events',
    'quote_requests',
    'contact_messages',
    'rate_limit_hits',
    'audit_log',
  ]
  for (const table of tables) {
    await db.prepare(`DELETE FROM ${table}`).run()
  }
}
