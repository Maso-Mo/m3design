-- ---------------------------------------------------------------------------
-- M3Design — schéma D1, migration 0008
-- Formulaires publics sans vérification par code (fin de l'étape WhatsApp)
-- ---------------------------------------------------------------------------
-- DÉCISION DE PRODUIT : l'intégration WhatsApp Business Platform et la
-- vérification OTP sont ABANDONNÉES. Les formulaires de devis et de contact
-- deviennent de simples formulaires : nom, adresse électronique, téléphone
-- facultatif et texte. La protection contre les abus passe désormais par la
-- limitation de débit, la validation stricte et un contrôle anti-robot
-- (`services/abuse-guard.ts`), et non plus par une preuve de numéro.
--
-- Ce que cette migration change, dans cet ordre :
--
--   1. les quatre déclencheurs qui exigeaient une preuve de vérification de
--      `otp_challenges` sont retirés (ils n'ont plus d'objet) ;
--   2. `quote_requests` et `contact_messages` sont reconstruites sans les colonnes
--      `phone_verification_id` et `phone_verified_at`, avec un état initial « new »
--      au lieu de « pending »/« verified » ;
--   3. `request_events` est reconstruite : ses colonnes `from_status`/`to_status`
--      n'acceptaient que les anciens états, et l'application écrirait désormais
--      « new », ce que la base refuserait ;
--   4. `rate_limit_hits` est reconstruite avec les portées du nouveau parcours
--      (les portées de vérification par code n'ont plus d'usage) ;
--   5. `otp_challenges` est supprimée : plus aucun code ne l'alimente.
--
-- POURQUOI UNE COLONNE `intake_version` : les demandes reçues AVANT cette
-- migration n'ont pas forcément d'adresse électronique (c'était un champ
-- facultatif), et il est hors de question de les modifier ou de les supprimer pour
-- satisfaire une nouvelle règle. Elles sont donc marquées « 1 » et restent valides
-- telles quelles, tandis que les demandes créées à partir de maintenant (« 2 »)
-- DOIVENT porter un nom, une adresse électronique et un texte : la base le
-- garantit elle-même, et pas seulement le service.
--
-- Aucune migration déjà appliquée n'est modifiée : tout est ici. Les données sont
-- recopiées, jamais réécrites — sauf le seul renommage d'état décrit ci-dessus,
-- qui traduit exactement la disparition de la notion de vérification.
-- ---------------------------------------------------------------------------

-- Reconstruction de tables parentes (référencées par `request_events` et
-- `email_outbox`) : le contrôle des clés étrangères est reporté à la validation de
-- la transaction, comme l'exige la procédure officielle SQLite pour un « rebuild ».
PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 0. Sauvegarde des lignes ENFANTES avant de reconstruire les tables parentes
-- ---------------------------------------------------------------------------
-- Pourquoi c'est indispensable, et non une précaution : D1 refuse
-- `PRAGMA foreign_keys = OFF`, et SQLite exécute un DELETE implicite lorsqu'on
-- supprime une table parente. Les clés étrangères d'`email_outbox` et de
-- `request_events` sont déclarées ON DELETE CASCADE : ce DELETE emporterait donc
-- les notifications et l'historique. `defer_foreign_keys` reporte le CONTRÔLE des
-- contraintes, pas les ACTIONS de clé étrangère — d'où cette copie explicite.
--
-- Les deux tables sont recopiées telles quelles (structure comprise) puis
-- restaurées à l'identique après reconstruction, identifiants compris.
CREATE TABLE _migration_0008_email_outbox AS
  SELECT * FROM email_outbox;

CREATE TABLE _migration_0008_request_events AS
  SELECT * FROM request_events;

-- ---------------------------------------------------------------------------
-- 1. Déclencheurs de preuve de vérification : supprimés
-- ---------------------------------------------------------------------------
-- Ils interrogeaient `otp_challenges` ; les garder interdirait de supprimer la
-- table, et les laisser en place refuserait toute nouvelle demande.
DROP TRIGGER trg_quote_requests_verification_insert;
DROP TRIGGER trg_quote_requests_verification_update;
DROP TRIGGER trg_contact_messages_verification_insert;
DROP TRIGGER trg_contact_messages_verification_update;

-- ---------------------------------------------------------------------------
-- 2. quote_requests : sans preuve de vérification, état initial « new »
-- ---------------------------------------------------------------------------
CREATE TABLE quote_requests_v2 (
  id INTEGER PRIMARY KEY,

  -- Référence publique unique, communiquée au client (jamais l'identifiant id).
  reference TEXT NOT NULL UNIQUE
    CONSTRAINT ck_quote_reference_format CHECK (
      length(reference) BETWEEN 14 AND 32
      AND reference GLOB 'DEV-[0-9][0-9][0-9][0-9]-[0-9A-Z]*'
    ),

  -- Téléphone FACULTATIF, et jamais présenté comme vérifié : il sert au rappel du
  -- client, pas à l'authentifier. Forme normalisée (E.164) pour les rapprochements.
  phone_normalized TEXT NULL
    CONSTRAINT ck_quote_phone_format CHECK (
      phone_normalized IS NULL
      OR (
        length(phone_normalized) BETWEEN 8 AND 16
        AND phone_normalized GLOB '+[1-9]*'
        AND phone_normalized NOT GLOB '*[^+0-9]*'
      )
    ),

  -- Numéro tel que saisi : c'est la forme que le client reconnaîtra au téléphone.
  phone_raw TEXT NULL
    CONSTRAINT ck_quote_phone_raw CHECK (
      phone_raw IS NULL OR length(phone_raw) BETWEEN 6 AND 32
    ),

  contact_name TEXT NULL
    CONSTRAINT ck_quote_contact_name CHECK (
      contact_name IS NULL OR length(contact_name) BETWEEN 1 AND 120
    ),

  contact_email TEXT NULL
    CONSTRAINT ck_quote_contact_email CHECK (
      contact_email IS NULL
      OR (
        contact_email = lower(contact_email)
        AND length(contact_email) BETWEEN 6 AND 254
        AND contact_email LIKE '%_@_%.__%'
      )
    ),

  -- Besoin exprimé par le client.
  description TEXT NULL
    CONSTRAINT ck_quote_description CHECK (
      description IS NULL OR length(description) BETWEEN 10 AND 2000
    ),


  -- new         : demande reçue, à traiter ;
  -- in_progress : prise en charge commerciale ;
  -- closed      : traitée ou abandonnée (seul état qui libère le téléphone).
  status TEXT NOT NULL DEFAULT 'new'
    CONSTRAINT ck_quote_status CHECK (
      status IN ('new', 'in_progress', 'closed')
    ),

  -- Version du formulaire qui a produit la ligne : 1 = parcours vérifié par code
  -- (historique), 2 = formulaire simple. Voir l'en-tête de cette migration.
  intake_version INTEGER NOT NULL DEFAULT 2
    CONSTRAINT ck_quote_intake_version CHECK (intake_version IN (1, 2)),

  -- Clé d'idempotence fournie par le client : un rejeu ne crée pas de doublon.
  idempotency_key TEXT NOT NULL
    CONSTRAINT ck_quote_idempotency_key CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
    ),

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Date de clôture (obligatoire dès que status = 'closed').
  closed_at INTEGER NULL,

  -- Date d'effacement des données personnelles (politique de conservation).
  anonymized_at INTEGER NULL,

  -- closed_at et status = 'closed' vont toujours ensemble.
  CONSTRAINT ck_quote_closed_at CHECK ((status = 'closed') = (closed_at IS NOT NULL)),

  -- Champs obligatoires du formulaire simple : nom, adresse électronique, texte.
  -- Les lignes historiques (intake_version = 1) en sont dispensées — elles ne
  -- peuvent pas être complétées rétroactivement sans inventer des données.
  CONSTRAINT ck_quote_intake_required CHECK (
    intake_version < 2
    OR anonymized_at IS NOT NULL
    OR (
      contact_name IS NOT NULL
      AND contact_email IS NOT NULL
      AND description IS NOT NULL
    )
  ),

  -- L'anonymisation n'a de sens qu'après clôture et efface tout le personnel.
  CONSTRAINT ck_quote_anonymized_only_when_closed CHECK (
    anonymized_at IS NULL OR status = 'closed'
  ),
  CONSTRAINT ck_quote_anonymized_cleared CHECK (
    anonymized_at IS NULL
    OR (
      phone_normalized IS NULL
      AND phone_raw IS NULL
      AND contact_name IS NULL
      AND contact_email IS NULL
      AND description IS NULL
    )
  ),

  CONSTRAINT ck_quote_dates CHECK (
    updated_at >= created_at
    AND (closed_at IS NULL OR closed_at >= created_at)
    AND (anonymized_at IS NULL OR anonymized_at >= created_at)
  )
);

-- Recopie des demandes existantes. Deux traductions, et rien d'autre :
--   * les états « pending » et « verified » deviennent « new » — sans vérification,
--     la distinction n'existe plus ;
--   * `intake_version` vaut 1 : ces lignes relèvent de l'ancien formulaire et ne
--     sont donc pas soumises aux champs obligatoires du nouveau.
INSERT INTO quote_requests_v2 (
  id, reference, phone_normalized, phone_raw, contact_name, contact_email,
  description, status, intake_version, idempotency_key, created_at, updated_at,
  closed_at, anonymized_at
)
SELECT
  id, reference, phone_normalized, phone_raw, contact_name, contact_email,
  description,
  CASE status WHEN 'pending' THEN 'new' WHEN 'verified' THEN 'new' ELSE status END,
  1, idempotency_key, created_at, updated_at, closed_at, anonymized_at
FROM quote_requests;

DROP TABLE quote_requests;
ALTER TABLE quote_requests_v2 RENAME TO quote_requests;

-- Une seule demande active par téléphone : la règle métier est garantie par la
-- base, y compris sous concurrence. Les demandes clôturées sortent de l'index, ce
-- qui autorise une nouvelle demande ensuite. Un téléphone absent (NULL) ne
-- déclenche évidemment rien : plusieurs demandes sans téléphone coexistent.
CREATE UNIQUE INDEX ux_quote_requests_active_phone
  ON quote_requests (phone_normalized)
  WHERE status <> 'closed';

-- Rejeu : une même clé d'idempotence ne peut pas produire deux demandes (index
-- créé par la migration 0006, recréé ici car la reconstruction l'a emporté).
CREATE UNIQUE INDEX ux_quote_requests_idempotency_key
  ON quote_requests (idempotency_key);

-- Suivi commercial (file d'attente par état).
CREATE INDEX ix_quote_requests_status_created_at
  ON quote_requests (status, created_at);

-- Historique par téléphone (support, détection d'abus).
CREATE INDEX ix_quote_requests_phone_created_at
  ON quote_requests (phone_normalized, created_at);

-- Politique de conservation : balayage des demandes clôturées à anonymiser.
CREATE INDEX ix_quote_requests_closed_at
  ON quote_requests (closed_at)
  WHERE closed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. contact_messages : même modèle que les devis, sans vérification
-- ---------------------------------------------------------------------------
-- Les deux formulaires ont désormais EXACTEMENT la même forme, à deux différences
-- près : le texte s'appelle `message` et la référence commence par « MSG ».
CREATE TABLE contact_messages_v2 (
  id INTEGER PRIMARY KEY,

  reference TEXT NOT NULL UNIQUE
    CONSTRAINT ck_contact_reference_format CHECK (
      length(reference) BETWEEN 14 AND 32
      AND reference GLOB 'MSG-[0-9][0-9][0-9][0-9]-[0-9A-Z]*'
    ),

  phone_normalized TEXT NULL
    CONSTRAINT ck_contact_phone_format CHECK (
      phone_normalized IS NULL
      OR (
        length(phone_normalized) BETWEEN 8 AND 16
        AND phone_normalized GLOB '+[1-9]*'
        AND phone_normalized NOT GLOB '*[^+0-9]*'
      )
    ),

  phone_raw TEXT NULL
    CONSTRAINT ck_contact_phone_raw CHECK (
      phone_raw IS NULL OR length(phone_raw) BETWEEN 6 AND 32
    ),

  contact_name TEXT NULL
    CONSTRAINT ck_contact_contact_name CHECK (
      contact_name IS NULL OR length(contact_name) BETWEEN 1 AND 120
    ),

  contact_email TEXT NULL
    CONSTRAINT ck_contact_contact_email CHECK (
      contact_email IS NULL
      OR (
        contact_email = lower(contact_email)
        AND length(contact_email) BETWEEN 6 AND 254
        AND contact_email LIKE '%_@_%.__%'
      )
    ),

  -- Message du client. Mêmes bornes que la description d'un devis.
  message TEXT NULL
    CONSTRAINT ck_contact_message CHECK (
      message IS NULL OR length(message) BETWEEN 10 AND 2000
    ),

  -- new         : message reçu, à traiter ;
  -- in_progress : réponse en cours ;
  -- closed      : traité (seul état qui autorise l'anonymisation).
  status TEXT NOT NULL DEFAULT 'new'
    CONSTRAINT ck_contact_status CHECK (
      status IN ('new', 'in_progress', 'closed')
    ),

  intake_version INTEGER NOT NULL DEFAULT 2
    CONSTRAINT ck_contact_intake_version CHECK (intake_version IN (1, 2)),

  idempotency_key TEXT NOT NULL
    CONSTRAINT ck_contact_idempotency_key CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
    ),

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  closed_at INTEGER NULL,
  anonymized_at INTEGER NULL,

  CONSTRAINT ck_contact_closed_at CHECK ((status = 'closed') = (closed_at IS NOT NULL)),

  -- Champs obligatoires du formulaire simple (mêmes règles que pour un devis).
  CONSTRAINT ck_contact_intake_required CHECK (
    intake_version < 2
    OR anonymized_at IS NOT NULL
    OR (
      contact_name IS NOT NULL
      AND contact_email IS NOT NULL
      AND message IS NOT NULL
    )
  ),

  CONSTRAINT ck_contact_anonymized_only_when_closed CHECK (
    anonymized_at IS NULL OR status = 'closed'
  ),
  CONSTRAINT ck_contact_anonymized_cleared CHECK (
    anonymized_at IS NULL
    OR (
      phone_normalized IS NULL
      AND phone_raw IS NULL
      AND contact_name IS NULL
      AND contact_email IS NULL
      AND message IS NULL
    )
  ),

  CONSTRAINT ck_contact_dates CHECK (
    updated_at >= created_at
    AND (closed_at IS NULL OR closed_at >= created_at)
    AND (anonymized_at IS NULL OR anonymized_at >= created_at)
  )
);

INSERT INTO contact_messages_v2 (
  id, reference, phone_normalized, phone_raw, contact_name, contact_email,
  message, status, intake_version, idempotency_key, created_at, updated_at,
  closed_at, anonymized_at
)
SELECT
  id, reference, phone_normalized, phone_raw, contact_name, contact_email,
  message,
  CASE status WHEN 'pending' THEN 'new' WHEN 'verified' THEN 'new' ELSE status END,
  1, idempotency_key, created_at, updated_at, closed_at, anonymized_at
FROM contact_messages;

DROP TABLE contact_messages;
ALTER TABLE contact_messages_v2 RENAME TO contact_messages;

-- Idempotence garantie par la base, comme pour les devis : c'est la migration 0008
-- qui comble cet écart — sans elle, deux envois simultanés portant la même clé
-- pouvaient produire deux messages (la recherche applicative n'est pas atomique).
CREATE UNIQUE INDEX ux_contact_messages_idempotency_key
  ON contact_messages (idempotency_key);

-- Suivi des messages (file d'attente par état).
CREATE INDEX ix_contact_messages_status_created_at
  ON contact_messages (status, created_at);

-- Historique par téléphone (support, détection d'abus).
CREATE INDEX ix_contact_messages_phone_created_at
  ON contact_messages (phone_normalized, created_at);

-- Politique de conservation : balayage des messages clôturés à anonymiser.
CREATE INDEX ix_contact_messages_closed_at
  ON contact_messages (closed_at)
  WHERE closed_at IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 4. request_events : états du nouveau parcours
-- ---------------------------------------------------------------------------
-- Reconstruction nécessaire, et pour une raison précise : les colonnes
-- `from_status`/`to_status` n'acceptaient que ('pending','verified','in_progress',
-- 'closed'). L'application écrit désormais un événement de création dont
-- `to_status` vaut « new » : sans cette reconstruction, la base refuserait
-- l'enregistrement de toute nouvelle demande.
--
-- `phone_verified` reste accepté comme valeur HISTORIQUE d'`event_type` : des
-- lignes existantes peuvent la porter (une vérification de numéro a bel et bien eu
-- lieu avant l'abandon de l'étape WhatsApp), et réécrire l'histoire pour faire
-- propre serait pire que de la conserver. L'application ne l'émet plus.
CREATE TABLE request_events_v2 (
  id INTEGER PRIMARY KEY,

  quote_request_id INTEGER NULL
    REFERENCES quote_requests (id) ON DELETE CASCADE,
  contact_message_id INTEGER NULL
    REFERENCES contact_messages (id) ON DELETE CASCADE,

  event_type TEXT NOT NULL
    CONSTRAINT ck_request_event_type CHECK (
      event_type IN (
        'created',
        'phone_verified',
        'status_changed',
        'corrected',
        'notification_queued',
        'anonymized'
      )
    ),

  from_status TEXT NULL
    CONSTRAINT ck_request_event_from_status CHECK (
      from_status IS NULL
      OR from_status IN ('new', 'in_progress', 'closed')
    ),
  to_status TEXT NULL
    CONSTRAINT ck_request_event_to_status CHECK (
      to_status IS NULL
      OR to_status IN ('new', 'in_progress', 'closed')
    ),

  actor TEXT NOT NULL
    CONSTRAINT ck_request_event_actor CHECK (
      actor IN ('client', 'admin', 'system')
    ),

  actor_user_id INTEGER NULL
    REFERENCES users (id) ON DELETE RESTRICT,

  reason TEXT NULL
    CONSTRAINT ck_request_event_reason CHECK (
      reason IS NULL OR length(reason) <= 300
    ),

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),

  CONSTRAINT ck_request_event_status_change CHECK (
    event_type <> 'status_changed'
    OR (from_status IS NOT NULL AND to_status IS NOT NULL)
  ),
  CONSTRAINT ck_request_event_admin_named CHECK (
    actor <> 'admin' OR actor_user_id IS NOT NULL
  ),
  CONSTRAINT ck_request_event_owner CHECK (
    (quote_request_id IS NOT NULL AND contact_message_id IS NULL)
    OR (quote_request_id IS NULL AND contact_message_id IS NOT NULL)
  )
);

INSERT INTO request_events_v2 (
  id, quote_request_id, contact_message_id, event_type, from_status, to_status,
  actor, actor_user_id, reason, created_at
)
SELECT
  id, quote_request_id, contact_message_id, event_type,
  CASE from_status
    WHEN 'pending' THEN 'new'
    WHEN 'verified' THEN 'new'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'closed' THEN 'closed'
    ELSE NULL
  END,
  CASE to_status
    WHEN 'pending' THEN 'new'
    WHEN 'verified' THEN 'new'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'closed' THEN 'closed'
    ELSE NULL
  END,
  actor, actor_user_id, reason, created_at
FROM request_events;

DROP TABLE request_events;
ALTER TABLE request_events_v2 RENAME TO request_events;

-- Historique chronologique d'une demande de devis.
CREATE INDEX ix_request_events_request_created_at
  ON request_events (quote_request_id, created_at);

-- Historique chronologique d'un message de contact.
CREATE INDEX ix_request_events_contact_created_at
  ON request_events (contact_message_id, created_at);

-- Activité d'un compte administratif (contrôle interne).
CREATE INDEX ix_request_events_actor_created_at
  ON request_events (actor_user_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. rate_limit_hits : portées du nouveau parcours
-- ---------------------------------------------------------------------------
-- L'anti-abus des formulaires compte les tentatives par empreinte (adresse IP,
-- adresse électronique, téléphone) sous la portée de l'action concernée. Les deux
-- portées de vérification par code disparaissent ; les portées conservées sont
-- celles du formulaire de devis, du formulaire de contact et de la connexion
-- administrative (à venir). Aucune ligne n'est perdue : elles sont recopiées.
CREATE TABLE rate_limit_hits_v2 (
  id INTEGER PRIMARY KEY,

  scope TEXT NOT NULL
    CONSTRAINT ck_rate_limit_hits_scope CHECK (
      scope IN ('quote_submit', 'contact_submit', 'admin_login')
    ),

  -- Empreinte HMAC-SHA-256 (hexadécimale) de la cible de la tentative. Aucun
  -- numéro, aucune adresse, aucun identifiant de compte n'est stocké ici.
  key_hash TEXT NOT NULL
    CONSTRAINT ck_rate_limit_hits_key_hash CHECK (
      length(key_hash) = 64
      AND key_hash GLOB '[0-9a-f]*'
      AND key_hash NOT GLOB '*[^0-9a-f]*'
    ),

  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO rate_limit_hits_v2 (id, scope, key_hash, created_at)
SELECT id, scope, key_hash, created_at
  FROM rate_limit_hits
 WHERE scope IN ('quote_submit', 'contact_submit', 'admin_login');

DROP TABLE rate_limit_hits;
ALTER TABLE rate_limit_hits_v2 RENAME TO rate_limit_hits;

-- Comptage des tentatives sur une fenêtre glissante.
CREATE INDEX ix_rate_limit_hits_scope_key_created_at
  ON rate_limit_hits (scope, key_hash, created_at);

-- Purge des lignes périmées.
CREATE INDEX ix_rate_limit_hits_created_at ON rate_limit_hits (created_at);

-- ---------------------------------------------------------------------------
-- 6. Restauration des lignes enfants, puis suppression de `otp_challenges`
-- ---------------------------------------------------------------------------
-- Les notifications et l'historique recopiés au point 0 sont remis tels quels. La
-- reconstruction des tables parentes les avait emportés (DELETE implicite de SQLite
-- sur une table parente, cascade comprise) : sans cette restauration, la V1
-- perdrait l'historique des demandes déjà reçues.
--
-- `INSERT OR REPLACE` : une ligne enfant qui aurait survécu à la reconstruction est
-- simplement réécrite à l'identique, ce qui rend la remise en état idempotente.
INSERT OR REPLACE INTO email_outbox (
  id, quote_request_id, contact_message_id, recipient, subject, body_text, status,
  attempts, next_attempt_at, last_error, created_at, sent_at
)
SELECT
  id, quote_request_id, contact_message_id, recipient, subject, body_text, status,
  attempts, next_attempt_at, last_error, created_at, sent_at
FROM _migration_0008_email_outbox;

DROP TABLE _migration_0008_email_outbox;

-- La restauration doit appliquer la MÊME traduction d'états que la reconstruction
-- du point 4 : les lignes recopiées portent les anciens libellés ('pending',
-- 'verified'), que la nouvelle contrainte `ck_request_event_to_status` refuse.
-- Sans cette traduction, la migration échouerait sur toute base contenant un
-- événement antérieur à la V1.
INSERT OR REPLACE INTO request_events (
  id, quote_request_id, contact_message_id, event_type, from_status, to_status,
  actor, actor_user_id, reason, created_at
)
SELECT
  id, quote_request_id, contact_message_id, event_type,
  CASE from_status
    WHEN 'pending' THEN 'new'
    WHEN 'verified' THEN 'new'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'closed' THEN 'closed'
    ELSE NULL
  END,
  CASE to_status
    WHEN 'pending' THEN 'new'
    WHEN 'verified' THEN 'new'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'closed' THEN 'closed'
    ELSE NULL
  END,
  actor, actor_user_id, reason, created_at
FROM _migration_0008_request_events;

DROP TABLE _migration_0008_request_events;

-- ---------------------------------------------------------------------------
-- 7. otp_challenges : supprimée
-- ---------------------------------------------------------------------------
-- Plus aucune table ne la référence : les deux colonnes de preuve ont disparu avec
-- la reconstruction de `quote_requests` et `contact_messages`, et les déclencheurs
-- qui l'interrogeaient ont été retirés en tête de migration. Aucun code ne
-- l'alimente ni ne la lit.
DROP TABLE otp_challenges;
