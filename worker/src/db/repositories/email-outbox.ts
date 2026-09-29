/**
 * Dépôt de la file d'attente des courriels (notifications de demande).
 *
 * Le schéma prévoit une file persistée plutôt qu'un envoi synchrone : une demande
 * de devis ne doit jamais échouer parce que le fournisseur de courriel est
 * momentanément indisponible, et un envoi doit pouvoir être réessayé puis purgé.
 *
 * Deux colonnes portent des données personnelles et sont donc traitées avec
 * précaution : `recipient` (adresse du client) et `body_text` (message, donc le
 * sujet du besoin). Elles ne sont jamais journalisées, jamais indexées, et sont
 * effacées par la purge. `last_error` ne reçoit qu'un code technique court, jamais
 * la réponse brute du fournisseur (qui peut recopier l'adresse ou le contenu).
 *
 * Anti-doublon : un même courriel n'est mis en file qu'une fois tant qu'une entrée
 * est en attente, en cours d'envoi ou déjà envoyée. Un renvoi reste possible après
 * un échec définitif.
 *
 * Cycle de vie d'une entrée, dans cet ordre et jamais autrement :
 *
 *   `pending` ──claim──▶ `sending` ──succès──▶ `sent`
 *       ▲                    │
 *       └─────échec──────────┘ (nouvel essai repoussé, puis `failed` au plafond)
 *
 * La PRISE SOUS BAIL (`claimEmailOutboxEntry`) est le cœur du dispositif : c'est
 * une seule instruction SQL conditionnelle, donc atomique. Deux traitements qui
 * examinent la même entrée en même temps ne peuvent pas la prendre tous les deux —
 * la base tranche. C'est ce qui empêche deux envois simultanés du même courriel,
 * sans verrou applicatif (D1 n'offre pas de transaction interactive).
 *
 * Le bail est aussi le délai de récupération : `next_attempt_at` est repoussé à
 * `now + leaseSeconds` au moment de la prise, et l'entrée redevient prenable
 * après cette échéance. Un traitement interrompu (limite de temps du Worker,
 * redéploiement) ne bloque donc pas la file indéfiniment. Le bail est très
 * supérieur au délai maximal d'un appel au fournisseur : en marche normale, une
 * entrée n'est jamais reprise pendant qu'elle est en cours d'envoi.
 *
 * Conséquence assumée : la file garantit un envoi AU MOINS une fois, pas
 * « exactement une fois ». Après un arrêt brutal pendant un envoi, un même
 * courriel peut partir deux fois — doublon rare et sans gravité, alors qu'une
 * demande jamais signalée serait une perte réelle.
 *
 * Vocabulaire, important : `sent` signifie que le fournisseur a ACCEPTÉ le message
 * et en a renvoyé un identifiant. Ce n'est pas une preuve de remise, et une ligne
 * de cette table n'est pas, en soi, un courriel envoyé.
 */

import { clampLimit, nowSeconds, type Db } from '../client'
import { changedRows, toDbError } from '../errors'

/** États d'une entrée de la file, alignés sur `ck_email_outbox_status`. */
export type EmailOutboxStatus =
  'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'

/** Ligne de `email_outbox` telle que renvoyée par la base. */
export type EmailOutboxRow = {
  id: number
  /** Demande de devis concernée, `null` pour une notification de contact. */
  quote_request_id: number | null
  /** Message de contact concerné, `null` pour une notification de devis. */
  contact_message_id: number | null
  recipient: string
  subject: string
  body_text: string
  status: EmailOutboxStatus
  attempts: number
  next_attempt_at: number
  last_error: string | null
  created_at: number
  sent_at: number | null
}

/** Colonnes renvoyées par toute lecture de la file. */
const COLUMNS = `id, quote_request_id, contact_message_id, recipient, subject,
  body_text, status, attempts, next_attempt_at, last_error, created_at, sent_at`

/** Plafond de tentatives imposé par le schéma (`ck_email_outbox_attempts`). */
const ATTEMPTS_CEILING = 20

/**
 * Durée par défaut d'un bail, en secondes.
 *
 * Deux minutes : très supérieur au délai maximal d'un appel au fournisseur
 * (30 secondes), donc jamais atteint en marche normale — une entrée prise est
 * toujours relâchée par son marquage, pas par l'expiration. Assez court, en
 * revanche, pour qu'une entrée abandonnée par un traitement interrompu soit
 * reprise rapidement sans intervention.
 */
export const DEFAULT_LEASE_SECONDS = 120

/**
 * Propriétaire d'une notification : exactement l'une des deux opérations.
 *
 * Le choix est interne (jamais dérivé d'une entrée client) et se traduit par deux
 * requêtes littérales distinctes, sans construction de SQL par concaténation.
 */
type NotificationOwner =
  | { kind: 'quote_request'; id: number }
  | { kind: 'contact_message'; id: number }

/**
 * Met en file la notification d'une opération.
 *
 * Renvoie `alreadyQueued: true` si une entrée VIVANTE existe déjà pour cette
 * opération (en attente, en cours ou envoyée) : la couche service peut appeler la
 * fonction sans risque d'envoyer deux fois le même courriel, ce qui compte autant
 * pour la relation client que pour les quotas d'envoi. Un échec définitif ou un
 * abandon libère l'opération, qui peut alors être notifiée de nouveau.
 *
 * Le contrôle d'unicité est refait par la base (index uniques partiels), qui
 * tranche en cas de course : deux insertions simultanées ne peuvent pas produire
 * deux notifications vivantes.
 */
async function enqueueNotification(
  db: Db,
  owner: NotificationOwner,
  input: {
    recipient: string
    subject: string
    bodyText: string
    now?: number
    notBefore?: number
  },
): Promise<{ email: EmailOutboxRow | null; alreadyQueued: boolean }> {
  const now = input.now ?? nowSeconds()
  const nextAttemptAt = input.notBefore ?? now

  const insert =
    owner.kind === 'quote_request'
      ? db.prepare(
          `INSERT INTO email_outbox (
             quote_request_id, recipient, subject, body_text, status, next_attempt_at, created_at
           )
           SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6
            WHERE NOT EXISTS (
              SELECT 1 FROM email_outbox AS existing
               WHERE existing.quote_request_id = ?1
                 AND existing.status IN ('pending', 'sending', 'sent')
            )
           RETURNING ${COLUMNS}`,
        )
      : db.prepare(
          `INSERT INTO email_outbox (
             contact_message_id, recipient, subject, body_text, status, next_attempt_at, created_at
           )
           SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6
            WHERE NOT EXISTS (
              SELECT 1 FROM email_outbox AS existing
               WHERE existing.contact_message_id = ?1
                 AND existing.status IN ('pending', 'sending', 'sent')
            )
           RETURNING ${COLUMNS}`,
        )

  try {
    const created = await insert
      .bind(
        owner.id,
        input.recipient,
        input.subject,
        input.bodyText,
        nextAttemptAt,
        now,
      )
      .first<EmailOutboxRow>()

    return { email: created ?? null, alreadyQueued: !created }
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Met en file la notification d'une demande de devis.
 *
 * Même mécanique que pour un message de contact : une seule implémentation, deux
 * propriétaires possibles.
 */
export async function enqueueQuoteNotification(
  db: Db,
  input: {
    quoteRequestId: number
    recipient: string
    subject: string
    bodyText: string
    now?: number
    notBefore?: number
  },
): Promise<{ email: EmailOutboxRow | null; alreadyQueued: boolean }> {
  return enqueueNotification(
    db,
    { kind: 'quote_request', id: input.quoteRequestId },
    input,
  )
}

/**
 * Met en file la notification d'un message de contact (prévenir M3Design).
 *
 * Le corps du message est celui du courriel adressé à M3Design, jamais un texte
 * fourni par le client : voir `services/notifications.ts`. La fonction
 * applique exactement la même règle anti-doublon que pour une demande de devis.
 */
export async function enqueueContactNotification(
  db: Db,
  input: {
    contactMessageId: number
    recipient: string
    subject: string
    bodyText: string
    now?: number
    notBefore?: number
  },
): Promise<{ email: EmailOutboxRow | null; alreadyQueued: boolean }> {
  return enqueueNotification(
    db,
    { kind: 'contact_message', id: input.contactMessageId },
    input,
  )
}

/**
 * Retrouve la notification d'une opération à partir de sa RÉFÉRENCE PUBLIQUE.
 *
 * Sert aux outils d'exploitation : la référence est la seule identité que le client
 * (ou l'exploitant qui vient de déposer une demande de test) a en main, alors que
 * la file ne connaît que des identifiants internes. Un seul point d'entrée pour les
 * deux opérations, au lieu de deux requêtes à écrire partout.
 *
 * La fonction ne filtre PAS sur l'état : elle rend la ligne telle qu'elle est, et
 * c'est l'appelant qui décide si elle est encore à envoyer. Cacher une entrée déjà
 * envoyée laisserait croire qu'il n'y a rien à faire, alors que le mot juste est
 * « c'est déjà parti ».
 *
 * Renvoie `null` si la référence est inconnue, ou si l'opération n'a jamais eu de
 * notification (échec de mise en file : la demande existe, la file non).
 */
export async function findEmailOutboxByReference(
  db: Db,
  reference: string,
): Promise<EmailOutboxRow | null> {
  try {
    const found = await db
      .prepare(
        `SELECT ${COLUMNS} FROM email_outbox
          WHERE quote_request_id IN (
                  SELECT id FROM quote_requests WHERE reference = ?1
                )
             OR contact_message_id IN (
                  SELECT id FROM contact_messages WHERE reference = ?1
                )
          ORDER BY id
          LIMIT 1`,
      )
      .bind(reference)
      .first<EmailOutboxRow>()

    return found ?? null
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Candidates au prochain envoi : entrées dues, sous le plafond de tentatives.
 *
 * Trois états sont lus, et c'est voulu :
 *   * `pending` : un nouvel essai est programmé et son heure est arrivée ;
 *   * `failed` : le plafond était atteint — l'entrée n'est reprise que si la couche
 *     service relève ce plafond, ce qui laisse une porte de sortie après une panne
 *     prolongée du fournisseur ;
 *   * `sending` : le bail est expiré, donc le traitement qui l'avait prise ne l'a
 *     pas relâchée (arrêt brutal). Elle est reprenable.
 *
 * Pour les trois, `next_attempt_at <= now` est la seule condition de temps : c'est
 * l'heure du prochain essai pour une entrée au repos, l'échéance du bail pour une
 * entrée en cours. Une entrée en cours d'envoi n'est donc JAMAIS proposée avant
 * l'expiration de son bail.
 *
 * Cette liste n'est qu'une proposition : elle est lue sans verrou, et c'est
 * `claimEmailOutboxEntry` qui décide, entrée par entrée. Un traitement qui perd la
 * course n'envoie rien.
 *
 * `maxAttempts` vient de la couche service : aucune politique d'envoi n'est figée
 * ici, ni la fréquence des essais ni leur nombre.
 */
export async function listDueEmailOutbox(
  db: Db,
  input: { now?: number; maxAttempts?: number; limit?: number },
): Promise<EmailOutboxRow[]> {
  const now = input.now ?? nowSeconds()
  const maxAttempts = clampLimit(input.maxAttempts, 5, ATTEMPTS_CEILING)
  const limit = clampLimit(input.limit, 25, 200)

  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM email_outbox
        WHERE status IN ('pending', 'failed', 'sending')
          AND next_attempt_at <= ?1
          AND attempts < ?2
        ORDER BY next_attempt_at, id
        LIMIT ?3`,
    )
    .bind(now, maxAttempts, limit)
    .all<EmailOutboxRow>()

  return result.results ?? []
}

/**
 * Prend une entrée sous bail, ou explique qu'un autre traitement l'a déjà prise.
 *
 * Tout tient dans cette instruction : le contrôle de l'état, celui de l'échéance et
 * celui du plafond de tentatives sont DANS le `WHERE`, et la mise à jour n'a lieu
 * que s'ils passent tous. La base tranche donc entre deux traitements concurrents,
 * et le perdant reçoit `null` — il n'envoie rien.
 *
 * L'essai est compté ici, une fois par tentative RÉELLE d'envoi : le marquage qui
 * suit (succès ou échec) ne l'incrémente plus. C'est ce qui rend `attempts` lisible
 * dans la table : il vaut exactement le nombre d'appels effectués au fournisseur.
 *
 * Renvoie la ligne prise (avec son état `sending` et son nouveau bail) ou `null`.
 */
export async function claimEmailOutboxEntry(
  db: Db,
  input: {
    emailId: number
    now?: number
    leaseSeconds?: number
    maxAttempts?: number
  },
): Promise<EmailOutboxRow | null> {
  const now = input.now ?? nowSeconds()
  const maxAttempts = clampLimit(input.maxAttempts, 5, ATTEMPTS_CEILING)
  const leaseSeconds = clampLimit(
    input.leaseSeconds,
    DEFAULT_LEASE_SECONDS,
    3600,
  )
  const leaseDeadline = now + leaseSeconds

  try {
    const claimed = await db
      .prepare(
        `UPDATE email_outbox
            SET status = 'sending',
                attempts = attempts + 1,
                next_attempt_at = ?2,
                last_error = NULL
          WHERE id = ?1
            AND status IN ('pending', 'failed', 'sending')
            AND next_attempt_at <= ?3
            AND attempts < ?4
          RETURNING ${COLUMNS}`,
      )
      .bind(input.emailId, leaseDeadline, now, maxAttempts)
      .first<EmailOutboxRow>()

    return claimed ?? null
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Marque une entrée prise comme acceptée par le fournisseur.
 *
 * Ce que ce marquage affirme, et rien de plus : le fournisseur a reçu le message et
 * l'a pris en charge. Il ne dit pas que le destinataire l'a lu, ni même qu'il est
 * arrivé — cela relève des notifications de remise du fournisseur, qui ne sont pas
 * mises en place à cette étape.
 *
 * La condition `status = 'sending'` est essentielle : seule une entrée prise par un
 * traitement peut être marquée. Une entrée jamais prise (ou déjà relâchée par un
 * autre chemin) renvoie `null`, et la couche service ne peut donc pas compter un
 * envoi qui n'a pas eu lieu.
 *
 * L'essai n'est PAS incrémenté ici : il l'a été à la prise sous bail, une fois par
 * appel réel au fournisseur.
 */
export async function markEmailOutboxSent(
  db: Db,
  input: { emailId: number; now?: number },
): Promise<EmailOutboxRow | null> {
  const now = input.now ?? nowSeconds()

  try {
    const updated = await db
      .prepare(
        `UPDATE email_outbox
            SET status = 'sent',
                sent_at = ?2,
                last_error = NULL
          WHERE id = ?1
            AND status = 'sending'
            AND attempts < ${ATTEMPTS_CEILING}
          RETURNING ${COLUMNS}`,
      )
      .bind(input.emailId, now)
      .first<EmailOutboxRow>()

    return updated ?? null
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Enregistre un échec d'envoi et programme la suite.
 *
 * L'entrée passe en `failed` lorsque le plafond de tentatives est atteint, en
 * `pending` sinon, avec un prochain essai repoussé par la couche service. Comme
 * pour le succès, l'essai n'est pas incrémenté ici (il l'a été à la prise) et seule
 * une entrée prise peut être marquée : deux traitements ne peuvent pas comptabiliser
 * deux fois le même échec.
 *
 * Seul un code technique court est conservé dans `last_error` : la réponse brute du
 * fournisseur peut contenir l'adresse du destinataire, elle n'est jamais écrite.
 */
export async function markEmailOutboxFailed(
  db: Db,
  input: {
    emailId: number
    errorCode: string
    retryAfterSeconds: number
    maxAttempts?: number
    now?: number
  },
): Promise<EmailOutboxRow | null> {
  const now = input.now ?? nowSeconds()
  const maxAttempts = clampLimit(input.maxAttempts, 5, ATTEMPTS_CEILING)
  const nextAttemptAt = now + Math.max(Math.floor(input.retryAfterSeconds), 1)

  try {
    const updated = await db
      .prepare(
        `UPDATE email_outbox
            SET status = CASE WHEN attempts >= ?4 THEN 'failed' ELSE 'pending' END,
                next_attempt_at = ?3,
                last_error = ?2
          WHERE id = ?1
            AND status = 'sending'
            AND attempts < ${ATTEMPTS_CEILING}
          RETURNING ${COLUMNS}`,
      )
      .bind(
        input.emailId,
        input.errorCode.slice(0, 500),
        nextAttemptAt,
        maxAttempts,
      )
      .first<EmailOutboxRow>()

    return updated ?? null
  } catch (error) {
    throw toDbError(error)
  }
}

/**
 * Purge les entrées envoyées ou annulées.
 *
 * C'est cette étape qui efface les données personnelles de la file (adresse du
 * destinataire, texte du message) une fois l'envoi acquis. Les entrées en attente
 * ou en échec ne sont jamais supprimées ici.
 */
export async function purgeEmailOutbox(
  db: Db,
  input: { sentBefore: number; limit?: number },
): Promise<number> {
  const limit = clampLimit(input.limit, 200, 1000)

  try {
    const result = await db
      .prepare(
        `DELETE FROM email_outbox
          WHERE id IN (
            SELECT id FROM email_outbox
             WHERE (status = 'sent' AND sent_at IS NOT NULL AND sent_at <= ?1)
                OR status = 'cancelled'
             ORDER BY id
             LIMIT ?2
          )`,
      )
      .bind(input.sentBefore, limit)
      .run()

    return changedRows(result)
  } catch (error) {
    throw toDbError(error)
  }
}
