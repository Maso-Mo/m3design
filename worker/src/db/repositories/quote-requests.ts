/**
 * Dépôt des demandes de devis.
 *
 * Aucune règle métier n'est décidée ici : ce module traduit des intentions en
 * SQL, dans le cadre imposé par le schéma. Trois garanties viennent de la base et
 * non du code appelant :
 *   * une seule demande active par numéro normalisé (index unique partiel) ;
 *   * une demande vérifiée porte forcément une preuve de vérification valide
 *     (contrainte + déclencheurs) ;
 *   * une clé d'idempotence ne peut produire qu'une seule demande.
 *
 * Les écritures qui doivent réussir ensemble sont regroupées dans un `batch` :
 * D1 exécute un lot comme une seule transaction (aucun entrelacement possible
 * entre deux lots, donc les conditions de garde restent valables d'une
 * instruction à l'autre).
 *
 * Les transitions d'état suivent un graphe fermé, appliqué en SQL :
 *   pending —(vérification du numéro)→ verified —→ in_progress —→ closed
 *                                            └———————————————→ closed
 * `closed` est un état final : seule la clôture libère le numéro pour une
 * nouvelle demande, ce qui évite d'avoir plusieurs demandes actives en parallèle.
 * Limite connue, à arbitrer par le métier (aucun changement de schéma à ce stade) :
 * une demande restée `pending` — numéro jamais confirmé — ne peut PAS être clôturée,
 * car les déclencheurs du schéma exigent une preuve de vérification valide dès que
 * l'état n'est plus `pending`. Son numéro reste donc réservé. Deux issues possibles
 * plus tard : un balayage des demandes `pending` trop anciennes (clôture et
 * effacement dans la même instruction, seul chemin accepté par les déclencheurs), ou
 * une migration dédiée. Cette décision relève de la conservation des données et de
 * la relation client, pas de la couche persistance.
 */

import { clampLimit, nowSeconds, type Db } from '../client'
import { changedRows, DbError, toDbError } from '../errors'

/** États d'une demande, alignés sur la contrainte `ck_quote_status`. */
export type QuoteRequestStatus = 'new' | 'in_progress' | 'closed'

/** États cibles acceptés par `updateQuoteRequestStatus`. */
export type QuoteRequestStatusTarget = 'in_progress' | 'closed'

/** Ligne de `quote_requests`, telle que renvoyée par la base (noms de colonnes). */
export type QuoteRequestRow = {
  id: number
  reference: string
  phone_normalized: string | null
  phone_raw: string | null
  contact_name: string | null
  contact_email: string | null
  description: string | null
  status: QuoteRequestStatus
  /**
   * Version du formulaire qui a produit la ligne : 1 = parcours vérifié par code
   * (historique), 2 = formulaire simple sans vérification. Voir la migration 0008.
   */
  intake_version: number
  idempotency_key: string
  created_at: number
  updated_at: number
  closed_at: number | null
  anonymized_at: number | null
}

export type CreateQuoteRequestInput = {
  reference: string
  idempotencyKey: string
  phoneNormalized: string | null
  phoneRaw: string | null
  description: string
  contactName: string | null
  contactEmail: string | null
  /**
   * Notification de M3Design à mettre en file dans le MÊME lot que la demande.
   *
   * Absente : aucune notification n'est créée (utile aux tests et aux usages
   * internes). Fournie : la demande et sa notification sont écrites ensemble, donc
   * une demande dont personne ne serait prévenu ne peut pas exister. Le contenu est
   * décidé par la couche service (`services/notifications.ts`).
   */
  notification?: QuoteNotificationDraft | null
  now?: number
}

/** Notification à mettre en file dans le même lot que la demande. */
export type QuoteNotificationDraft = {
  recipient: string
  subject: string
  bodyText: string
}

export type CreateQuoteRequestOutcome = {
  quote: QuoteRequestRow
  /** Vrai lorsque la clé d'idempotence était déjà connue : aucune ligne créée. */
  replayed: boolean
  /**
   * Vrai lorsque ce lot a mis la notification en file. Faux en rejeu (aucune
   * écriture) et faux lorsqu'aucune notification n'a été demandée.
   */
  notificationQueued: boolean
}

/** Colonnes renvoyées par toute lecture de demande. */
const COLUMNS = `id, reference, phone_normalized, phone_raw, contact_name, contact_email,
  description, status, intake_version, idempotency_key,
  created_at, updated_at, closed_at, anonymized_at`

/** États sources autorisés pour chaque état cible (graphe de transitions). */
const ALLOWED_SOURCE_STATUSES: Record<
  QuoteRequestStatusTarget,
  QuoteRequestStatus[]
> = {
  in_progress: ['new'],
  closed: ['new', 'in_progress'],
}

/** Construit la liste de paramètres `IN (?, ?, …)` d'un ensemble fermé. */
function placeholders(count: number, firstIndex: number): string {
  return Array.from(
    { length: count },
    (_, offset) => `?${firstIndex + offset}`,
  ).join(', ')
}

/** Lecture d'une demande par sa clé d'idempotence (détection de rejeu). */
export async function findQuoteRequestByIdempotencyKey(
  db: Db,
  idempotencyKey: string,
): Promise<QuoteRequestRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM quote_requests WHERE idempotency_key = ?1`)
    .bind(idempotencyKey)
    .first<QuoteRequestRow>()
  return row ?? null
}

/** Lecture d'une demande par sa référence publique. */
export async function findQuoteRequestByReference(
  db: Db,
  reference: string,
): Promise<QuoteRequestRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM quote_requests WHERE reference = ?1`)
    .bind(reference)
    .first<QuoteRequestRow>()
  return row ?? null
}

/** Lecture interne par identifiant (diagnostics, jamais exposée telle quelle). */
async function findQuoteRequestById(
  db: Db,
  quoteId: number,
): Promise<QuoteRequestRow | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM quote_requests WHERE id = ?1`)
    .bind(quoteId)
    .first<QuoteRequestRow>()
  return row ?? null
}

/**
 * Crée une demande de devis.
 *
 * Le téléphone est FACULTATIF et n'est jamais vérifié : il ne sert qu'à rappeler le
 * client. Le nom, l'adresse électronique et la description sont, eux, obligatoires —
 * la base le garantit elle-même pour les lignes de la V1 (`ck_quote_intake_required`,
 * dont les lignes historiques sont dispensées).
 *
 * Le rejeu d'une même clé d'idempotence ne crée jamais de seconde demande : la
 * ligne déjà enregistrée est renvoyée avec `replayed: true`.
 */
export async function createQuoteRequest(
  db: Db,
  input: CreateQuoteRequestInput,
): Promise<CreateQuoteRequestOutcome> {
  const alreadyStored = await findQuoteRequestByIdempotencyKey(
    db,
    input.idempotencyKey,
  )
  if (alreadyStored) {
    return { quote: alreadyStored, replayed: true, notificationQueued: false }
  }

  const now = input.now ?? nowSeconds()
  const notification = input.notification ?? null

  const statements = [
    db
      .prepare(
        `INSERT INTO quote_requests (
           reference, phone_normalized, phone_raw, contact_name, contact_email,
           description, status, idempotency_key, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7, ?8, ?8)
         RETURNING ${COLUMNS}`,
      )
      .bind(
        input.reference,
        input.phoneNormalized,
        input.phoneRaw,
        input.contactName,
        input.contactEmail,
        input.description,
        input.idempotencyKey,
        now,
      ),
    db
      .prepare(
        `INSERT INTO request_events (quote_request_id, event_type, actor, from_status, to_status, created_at)
         SELECT id, 'created', 'client', NULL, status, ?2
           FROM quote_requests
          WHERE idempotency_key = ?1`,
      )
      .bind(input.idempotencyKey, now),
  ]

  if (notification !== null) {
    // Même règle anti-doublon que la file : une seule notification VIVANTE par
    // demande, la base tranchant en dernier ressort (index unique partiel).
    statements.push(
      db
        .prepare(
          `INSERT INTO email_outbox (
             quote_request_id, recipient, subject, body_text, status,
             next_attempt_at, created_at
           )
           SELECT id, ?2, ?3, ?4, 'pending', ?5, ?5
             FROM quote_requests
            WHERE idempotency_key = ?1
              AND NOT EXISTS (
                SELECT 1 FROM email_outbox AS existing
                 WHERE existing.quote_request_id = quote_requests.id
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

    const created = results[0]?.results?.[0] as QuoteRequestRow | undefined
    if (!created) {
      throw new DbError('db_unavailable')
    }
    return {
      quote: created,
      replayed: false,
      notificationQueued: notification !== null && changedRows(results[2]) > 0,
    }
  } catch (error) {
    // Course possible : une autre requête a enregistré la même clé d'idempotence
    // pendant celle-ci. La demande existante est alors renvoyée (aucun doublon) ;
    // sinon l'erreur d'origine est traduite en code de domaine.
    const raced = await findQuoteRequestByIdempotencyKey(
      db,
      input.idempotencyKey,
    )
    if (raced) {
      return { quote: raced, replayed: true, notificationQueued: false }
    }
    throw toDbError(error)
  }
}

/**
 * Fait avancer une demande dans le graphe des états, en journalisant le changement.
 *
 * Transitions autorisées par `ALLOWED_SOURCE_STATUSES` : `new → in_progress`,
 * `new → closed`, `in_progress → closed`. `closed` est FINAL : une demande close ne
 * se rouvre pas. Tout refus est décidé par la BASE, dans la même instruction que la
 * mise à jour : un événement ne peut donc jamais être écrit pour un changement
 * refusé.
 */
export async function updateQuoteRequestStatus(
  db: Db,
  input: {
    quoteId: number
    toStatus: QuoteRequestStatusTarget
    actor: 'client' | 'admin' | 'system'
    actorUserId?: number | null
    reason?: string | null
    now?: number
  },
): Promise<QuoteRequestRow> {
  const now = input.now ?? nowSeconds()
  const allowedSources = ALLOWED_SOURCE_STATUSES[input.toStatus]
  if (allowedSources === undefined) {
    throw new DbError('quote_status_transition_refused')
  }

  // Numérotation des paramètres liés : chaque instruction a la sienne. L'insertion
  // d'événement lie ?1..?6 puis la liste des états sources à partir de ?7 ; la mise à
  // jour lie en plus `closed_at` en ?7, donc ses états sources commencent à ?8.
  // Se tromper ici ne se voit pas à la compilation : la base refuse alors la requête
  // (nombre de paramètres incohérent), d'où un 503 au lieu d'un changement d'état.
  const insertSources = placeholders(allowedSources.length, 7)
  const updateSources = placeholders(allowedSources.length, 8)
  const closedAt = input.toStatus === 'closed' ? now : null
  const actorUserId = input.actorUserId ?? null
  const reason = input.reason ?? null

  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO request_events (
             quote_request_id, event_type, actor, actor_user_id, from_status,
             to_status, reason, created_at
           )
           SELECT id, 'status_changed', ?4, ?5, status, ?2, ?6, ?1
             FROM quote_requests
            WHERE id = ?3 AND status IN (${insertSources}) AND anonymized_at IS NULL`,
        )
        .bind(
          now,
          input.toStatus,
          input.quoteId,
          input.actor,
          actorUserId,
          reason,
          ...allowedSources,
        ),
      db
        .prepare(
          `UPDATE quote_requests
              SET status = ?2, closed_at = ?7, updated_at = ?1
            WHERE id = ?3 AND status IN (${updateSources}) AND anonymized_at IS NULL
            RETURNING ${COLUMNS}`,
        )
        .bind(
          now,
          input.toStatus,
          input.quoteId,
          input.actor,
          actorUserId,
          reason,
          closedAt,
          ...allowedSources,
        ),
    ])

    const updated = results[1]?.results?.[0] as QuoteRequestRow | undefined
    if (updated) {
      return updated
    }

    const current = await findQuoteRequestById(db, input.quoteId)
    if (current === null) {
      throw new DbError('quote_not_found')
    }
    throw new DbError('quote_status_transition_refused')
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Efface les données personnelles des demandes clôturées depuis assez longtemps.
 *
 * Politique de conservation : les coordonnées et le texte du besoin n'ont pas à être
 * gardés indéfiniment, mais la référence et les dates restent (comptabilité,
 * historique). Seules les demandes DÉJÀ CLOSES et antérieures à `closedBefore` sont
 * touchées, par lots bornés : un passage ne peut pas vider la table d'un coup.
 *
 * Renvoie le nombre de demandes anonymisées.
 */
export async function anonymizeClosedQuoteRequests(
  db: Db,
  input: { closedBefore: number; now?: number; limit?: number },
): Promise<number> {
  const now = input.now ?? nowSeconds()
  const limit = clampLimit(input.limit, 200, 1000)
  const selection = `SELECT id FROM quote_requests
        WHERE status = 'closed'
          AND closed_at IS NOT NULL
          AND closed_at <= ?2
          AND anonymized_at IS NULL
        ORDER BY closed_at
        LIMIT ?3`

  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO request_events (
             quote_request_id, event_type, actor, from_status, to_status, reason,
             created_at
           )
           SELECT id, 'anonymized', 'system', status, status, 'conservation', ?1
             FROM quote_requests
            WHERE id IN (${selection})`,
        )
        .bind(now, input.closedBefore, limit),
      db
        .prepare(
          `UPDATE quote_requests
              SET phone_normalized = NULL,
                  phone_raw = NULL,
                  contact_name = NULL,
                  contact_email = NULL,
                  description = NULL,
                  anonymized_at = ?1
            WHERE id IN (${selection})`,
        )
        .bind(now, input.closedBefore, limit),
    ])

    return changedRows(results[1])
  } catch (error) {
    throw toDbError(error)
  }
}
