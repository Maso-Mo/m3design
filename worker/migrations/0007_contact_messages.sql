-- ---------------------------------------------------------------------------
-- M3Design — schéma D1, migration 0007
-- Formulaire de contact : messages dont le numéro est vérifié par WhatsApp
-- ---------------------------------------------------------------------------
-- Cette migration ajoute la SECONDE opération publique du site (après la demande
-- de devis) et les objets qui vont avec. Trois changements, dans cet ordre :
--
--   1. `otp_challenges.purpose` accepte une seconde valeur, 'contact'. Une
--      vérification de numéro reste liée à UNE opération : une preuve obtenue pour
--      un devis ne peut pas servir à un message de contact, et réciproquement.
--      SQLite ne sait pas modifier une contrainte CHECK : la table est donc
--      reconstruite (procédure officielle « rebuild » de la documentation SQLite),
--      en préservant toutes ses lignes.
--
--   2. `contact_messages` : la table des messages, écrite sur le même modèle que
--      `quote_requests` (référence publique, preuve de vérification liée,
--      idempotence, anonymisation à la clôture). Comme pour les devis, la base
--      refuse elle-même un message dont le numéro n'a pas été vérifié.
--
--   3. `request_events` et `email_outbox` deviennent polymorphes : leur
--      propriétaire est soit une demande de devis, soit un message de contact
--      (`quote_request_id` XOR `contact_message_id`). Le journal d'activité et la
--      file de notifications restent donc des objets UNIQUES pour les deux
--      opérations, au lieu d'être dupliqués — et un message de contact bénéficie
--      de la même traçabilité qu'un devis.
--
-- Deux points de méthode, vérifiés sur workerd (le SQLite de D1) avant d'écrire
-- ce fichier, car ils décident de la rédaction :
--
--   * `PRAGMA foreign_keys = OFF` est IGNORÉ par D1 (le moteur refuse de désactiver
--     les clés étrangères). La seule façon de retirer une table parente référencée
--     par des lignes existantes est `PRAGMA defer_foreign_keys = ON`, qui repousse
--     le contrôle à la validation de la transaction. Les lignes de
--     `otp_challenges` sont recopiées dans la table reconstruite DANS la même
--     transaction : au commit, les devis retrouvent leur parent et le contrôle
--     passe. `worker/tests/migrations.test.ts` le vérifie sur une base contenant
--     réellement un challenge consommé, un devis, un événement et une notification.
--   * les déclencheurs de `quote_requests` qui lisent `otp_challenges` sont retirés
--     puis recréés à l'identique : SQLite refuse de renommer une table tant qu'un
--     déclencheur la référence sous son nom d'origine. Leur comportement, lui, ne
--     change pas d'un caractère.
--
-- Aucune migration déjà appliquée n'est modifiée : tout est ici.
-- ---------------------------------------------------------------------------

-- Report du contrôle des clés étrangères à la validation de la transaction :
-- indispensable pour reconstruire `otp_challenges` alors que des devis vérifiés
-- existent (voir point 1 ci-dessus).
PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. otp_challenges : purpose accepte aussi 'contact'
-- ---------------------------------------------------------------------------

-- Les deux déclencheurs des devis lisent `otp_challenges` : ils sont retirés le
-- temps de la reconstruction et recréés à l'identique en fin de section 1.
DROP TRIGGER trg_quote_requests_verification_insert;
DROP TRIGGER trg_quote_requests_verification_update;

-- Copie de travail des lignes. Elle contient exactement les données de
-- `otp_challenges` — rien de plus, rien de moins — et disparaît à la fin de la
-- même transaction : aucune donnée ne survit hors de la table définitive.
CREATE TABLE _migration_0007_otp_challenges AS SELECT * FROM otp_challenges;

CREATE TABLE otp_challenges_v2 (
  id INTEGER PRIMARY KEY,

  -- Numéro au format international (E.164), normalisé côté serveur.
  phone_normalized TEXT NOT NULL
    CONSTRAINT ck_otp_phone_format CHECK (
      length(phone_normalized) BETWEEN 8 AND 16
      AND phone_normalized GLOB '+[1-9]*'
      AND phone_normalized NOT GLOB '*[^+0-9]*'
    ),

  -- SEUL changement de la table : 'contact' rejoint 'quote_request'. La colonne
  -- reste une liste fermée : aucune valeur libre ne peut entrer ici.
  purpose TEXT NOT NULL
    CONSTRAINT ck_otp_purpose CHECK (purpose IN ('quote_request', 'contact')),

  -- Empreinte hexadécimale (64 caractères) du code. Jamais le code lui-même.
  -- La contrainte n'accepte que de l'hexadécimal minuscule : impossible d'y
  -- écrire un code en clair, même par erreur de programmation.
  code_hash TEXT NOT NULL
    CONSTRAINT ck_otp_code_hash CHECK (
      length(code_hash) = 64
      AND code_hash GLOB '[0-9a-f]*'
      AND code_hash NOT GLOB '*[^0-9a-f]*'
    ),

  -- Algorithme d'empreinte, conservé pour pouvoir migrer sans ambiguïté.
  hash_algorithm TEXT NOT NULL DEFAULT 'hmac-sha256'
    CONSTRAINT ck_otp_hash_algorithm CHECK (
      length(hash_algorithm) BETWEEN 3 AND 32
    ),

  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ck_otp_status CHECK (
      status IN ('pending', 'verified', 'failed', 'expired', 'superseded')
    ),

  attempts INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_otp_attempts CHECK (attempts >= 0),

  -- Politique de tentatives figée pour ce challenge (le serveur la transmet).
  max_attempts INTEGER NOT NULL
    CONSTRAINT ck_otp_max_attempts CHECK (max_attempts BETWEEN 1 AND 10),

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Date d'expiration du code : toujours postérieure à la création.
  expires_at INTEGER NOT NULL,

  -- Date de sortie de l'état pending (quelle qu'en soit la raison).
  closed_at INTEGER NULL,

  -- Date de la vérification réussie (uniquement pour status = 'verified').
  verified_at INTEGER NULL,

  -- Fin de validité de la preuve issue de cette vérification.
  proof_valid_until INTEGER NULL,

  CONSTRAINT ck_otp_attempts_limit CHECK (attempts <= max_attempts),
  CONSTRAINT ck_otp_expires_at CHECK (expires_at > created_at),
  CONSTRAINT ck_otp_closed_at CHECK ((status = 'pending') = (closed_at IS NULL)),
  CONSTRAINT ck_otp_verified_at CHECK (
    (status = 'verified') = (verified_at IS NOT NULL)
  ),
  CONSTRAINT ck_otp_proof_window CHECK (
    proof_valid_until IS NULL
    OR (status = 'verified' AND proof_valid_until > verified_at)
  )
);

-- Échange des deux tables : la nouvelle prend la place de l'ancienne…
DROP TABLE otp_challenges;
ALTER TABLE otp_challenges_v2 RENAME TO otp_challenges;

-- … et les lignes reviennent, identifiant compris. Les identifiants sont ceux de
-- l'ancienne table : les références des devis (`phone_verification_id`) restent

-- ---------------------------------------------------------------------------
-- 1 bis. Déclencheurs des devis, recréés à l'identique
-- ---------------------------------------------------------------------------
-- Copie exacte de la migration 0003 : même nom, même condition, même jeton
-- d'abandon. Seule leur place dans le fichier change (ils ne pouvaient pas rester
-- en place pendant la reconstruction de `otp_challenges`).
CREATE TRIGGER trg_quote_requests_verification_insert
BEFORE INSERT ON quote_requests
FOR EACH ROW
WHEN NEW.status <> 'pending' AND NEW.anonymized_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'M3DESIGN_CONSTRAINT_QUOTE_VERIFICATION_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM otp_challenges AS challenge
    WHERE challenge.id = NEW.phone_verification_id
      AND challenge.purpose = 'quote_request'
      AND challenge.status = 'verified'
      AND challenge.verified_at IS NOT NULL
      AND challenge.proof_valid_until IS NOT NULL
      AND challenge.phone_normalized = NEW.phone_normalized
      AND NEW.phone_verified_at BETWEEN challenge.verified_at
        AND challenge.proof_valid_until
  );
END;

CREATE TRIGGER trg_quote_requests_verification_update
BEFORE UPDATE ON quote_requests
FOR EACH ROW
WHEN NEW.status <> 'pending' AND NEW.anonymized_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'M3DESIGN_CONSTRAINT_QUOTE_VERIFICATION_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM otp_challenges AS challenge
    WHERE challenge.id = NEW.phone_verification_id
      AND challenge.purpose = 'quote_request'
      AND challenge.status = 'verified'
      AND challenge.verified_at IS NOT NULL
      AND challenge.proof_valid_until IS NOT NULL
      AND challenge.phone_normalized = NEW.phone_normalized
      AND NEW.phone_verified_at BETWEEN challenge.verified_at
        AND challenge.proof_valid_until
  );
END;

-- donc valides, sans qu'aucune ligne de `quote_requests` soit touchée.
INSERT INTO otp_challenges (
  id, phone_normalized, purpose, code_hash, hash_algorithm, status, attempts,
  max_attempts, created_at, expires_at, closed_at, verified_at, proof_valid_until
)
SELECT
  id, phone_normalized, purpose, code_hash, hash_algorithm, status, attempts,
  max_attempts, created_at, expires_at, closed_at, verified_at, proof_valid_until
FROM _migration_0007_otp_challenges;

DROP TABLE _migration_0007_otp_challenges;

-- Index de l'ancienne table, recréés à l'identique (ils ont disparu avec elle).
-- L'unicité porte sur le couple (numéro, opération) : un numéro peut donc avoir
-- un devis ET un message de contact en attente, mais un seul de chaque.
CREATE UNIQUE INDEX ux_otp_challenges_pending
  ON otp_challenges (phone_normalized, purpose)
  WHERE status = 'pending';

CREATE INDEX ix_otp_challenges_phone_created_at
  ON otp_challenges (phone_normalized, created_at);

CREATE INDEX ix_otp_challenges_expires_at ON otp_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- 2. contact_messages : messages du formulaire de contact
-- ---------------------------------------------------------------------------
-- Même modèle que `quote_requests` — référence publique unique, idempotence,
-- preuve de vérification liée, anonymisation à la clôture — avec UNE différence
-- voulue : il n'existe pas d'état « non vérifié » côté contact. Le parcours
-- public consomme la preuve AVANT d'écrire la ligne, et la base l'impose
-- ci-dessous : un message de contact sans preuve valide ne peut pas exister.
-- C'est la traduction exacte de la règle « aucune demande publique non vérifiée ».
CREATE TABLE contact_messages (
  id INTEGER PRIMARY KEY,

  -- Référence publique unique, communiquée au client (jamais l'identifiant id).
  reference TEXT NOT NULL UNIQUE
    CONSTRAINT ck_contact_reference_format CHECK (
      length(reference) BETWEEN 14 AND 32
      AND reference GLOB 'MSG-[0-9][0-9][0-9][0-9]-[0-9A-Z]*'
    ),

  -- Numéro normalisé côté serveur. NULL uniquement après anonymisation, comme
  -- pour les devis : c'est ce qui permet d'effacer les données personnelles sans
  -- perdre la référence ni les dates.
  phone_normalized TEXT NULL
    CONSTRAINT ck_contact_phone_format CHECK (
      phone_normalized IS NULL
      OR (
        length(phone_normalized) BETWEEN 8 AND 16
        AND phone_normalized GLOB '+[1-9]*'
        AND phone_normalized NOT GLOB '*[^+0-9]*'
      )
    ),

  -- Numéro tel que saisi par le client : utile au support et aux corrections.
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

  -- Message du client. Mêmes bornes que la description d'un devis : 10 à
  -- 2000 caractères, ce qui laisse la place au contexte sans ouvrir la porte aux
  -- envois massifs.
  message TEXT NULL
    CONSTRAINT ck_contact_message CHECK (
      message IS NULL OR length(message) BETWEEN 10 AND 2000
    ),

  -- verified    : message reçu et numéro confirmé côté serveur (état initial) ;
  -- in_progress : prise en charge (réponse en cours) ;
  -- closed      : traité (seul état qui autorise l'anonymisation).
  status TEXT NOT NULL DEFAULT 'verified'
    CONSTRAINT ck_contact_status CHECK (
      status IN ('verified', 'in_progress', 'closed')
    ),

  -- Preuve de vérification (ligne de otp_challenges consommée par le serveur).
  -- La suppression du challenge est refusée (RESTRICT) tant qu'un message s'y
  -- réfère : la preuve reste vérifiable pendant la durée de conservation.
  phone_verification_id INTEGER NULL
    REFERENCES otp_challenges (id) ON DELETE RESTRICT,

  phone_verified_at INTEGER NULL,

  -- Clé d'idempotence fournie par le client : un rejeu ne crée pas de doublon.
  idempotency_key TEXT NOT NULL
    CONSTRAINT ck_contact_idempotency_key CHECK (
      length(idempotency_key) BETWEEN 16 AND 128
    ),

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Renseigné uniquement à la clôture.
  closed_at INTEGER NULL,

  -- Date d'effacement des données personnelles (politique de conservation).
  anonymized_at INTEGER NULL,

  -- Un message n'est vérifié que par une preuve liée (sauf anonymisation, qui
  -- efface justement ce lien). C'est la traduction en base de la règle « aucune
  -- demande publique non vérifiée » : sans preuve, pas de ligne.
  CONSTRAINT ck_contact_verified_requires_proof CHECK (
    anonymized_at IS NOT NULL
    OR (phone_verified_at IS NOT NULL AND phone_verification_id IS NOT NULL)
  ),

  -- closed_at et status = 'closed' vont toujours ensemble.
  CONSTRAINT ck_contact_closed_at CHECK ((status = 'closed') = (closed_at IS NOT NULL)),

  -- Tant qu'un message n'est pas anonymisé, les données nécessaires au traitement
  -- sont présentes.
  CONSTRAINT ck_contact_personal_data CHECK (
    anonymized_at IS NOT NULL
    OR (
      phone_normalized IS NOT NULL
      AND phone_raw IS NOT NULL
      AND message IS NOT NULL
    )
  ),

  -- L'anonymisation n'a de sens qu'après clôture et efface tout le personnel.
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
      AND phone_verification_id IS NULL
    )
  ),

  CONSTRAINT ck_contact_dates CHECK (
    updated_at >= created_at
    AND (closed_at IS NULL OR closed_at >= created_at)
    AND (anonymized_at IS NULL OR anonymized_at >= created_at)
    AND (phone_verified_at IS NULL OR phone_verified_at > 0)
  )
);

-- Une preuve de vérification ne peut autoriser qu'UN message : le rejeu d'un
-- challenge consommé est refusé par la base elle-même — même garantie que pour
-- les devis, appliquée à la seconde opération.
CREATE UNIQUE INDEX ux_contact_messages_phone_verification
  ON contact_messages (phone_verification_id)
  WHERE phone_verification_id IS NOT NULL;

-- Suivi des messages (file d'attente par état).
CREATE INDEX ix_contact_messages_status_created_at
  ON contact_messages (status, created_at);

-- Historique par numéro (support, détection d'abus).
CREATE INDEX ix_contact_messages_phone_created_at
  ON contact_messages (phone_normalized, created_at);

-- Politique de conservation : balayage des messages clôturés à anonymiser.
CREATE INDEX ix_contact_messages_closed_at
  ON contact_messages (closed_at)
  WHERE closed_at IS NOT NULL;

-- Contrôle de la preuve de vérification (insertion et mise à jour).
--
-- Même principe que pour les devis : le message d'abandon est un jeton technique
-- stable, que le code applicatif traduit en erreur générique. La SEULE différence
-- avec les devis est la valeur d'opération exigée : 'contact'. Une preuve obtenue
-- pour un devis ne peut donc pas ouvrir un message de contact, même si le numéro
-- est identique — et réciproquement.
CREATE TRIGGER trg_contact_messages_verification_insert
BEFORE INSERT ON contact_messages
FOR EACH ROW
WHEN NEW.anonymized_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'M3DESIGN_CONSTRAINT_CONTACT_VERIFICATION_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM otp_challenges AS challenge
    WHERE challenge.id = NEW.phone_verification_id
      AND challenge.purpose = 'contact'
      AND challenge.status = 'verified'
      AND challenge.verified_at IS NOT NULL
      AND challenge.proof_valid_until IS NOT NULL
      AND challenge.phone_normalized = NEW.phone_normalized
      AND NEW.phone_verified_at BETWEEN challenge.verified_at
        AND challenge.proof_valid_until
  );
END;

CREATE TRIGGER trg_contact_messages_verification_update
BEFORE UPDATE ON contact_messages
FOR EACH ROW
WHEN NEW.anonymized_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'M3DESIGN_CONSTRAINT_CONTACT_VERIFICATION_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM otp_challenges AS challenge
    WHERE challenge.id = NEW.phone_verification_id
      AND challenge.purpose = 'contact'
      AND challenge.status = 'verified'
      AND challenge.verified_at IS NOT NULL
      AND challenge.proof_valid_until IS NOT NULL
      AND challenge.phone_normalized = NEW.phone_normalized
      AND NEW.phone_verified_at BETWEEN challenge.verified_at
        AND challenge.proof_valid_until
  );
END;

-- ---------------------------------------------------------------------------
-- 3. request_events : un journal, deux origines possibles
-- ---------------------------------------------------------------------------
-- Le journal d'activité servait une seule opération ; il en sert désormais deux.
-- Plutôt que de le dupliquer (deux tables, deux jeux d'index, deux vocabulaires),
-- la table reçoit deux colonnes de rattachement dont EXACTEMENT UNE est remplie.
--
-- Les lignes existantes (devis) sont recopiées telles quelles : `quote_request_id`
-- garde sa valeur, `contact_message_id` reste NULL. La reconstruction est
-- nécessaire pour rendre `quote_request_id` facultatif — la colonne était NOT NULL.
-- Elle est sans danger vis-à-vis des clés étrangères : aucune ligne d'aucune table
-- ne référence `request_events`, et cette table ne fait que pointer vers d'autres.
CREATE TABLE request_events_v2 (
  id INTEGER PRIMARY KEY,

  -- Propriété : l'objet suivi (demande de devis OU message de contact). Supprimer
  -- l'objet efface son historique, dans les deux cas.
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
      OR from_status IN ('pending', 'verified', 'in_progress', 'closed')
    ),
  to_status TEXT NULL
    CONSTRAINT ck_request_event_to_status CHECK (
      to_status IS NULL
      OR to_status IN ('pending', 'verified', 'in_progress', 'closed')
    ),

  -- Qui a agi : le client, un compte administratif ou le serveur.
  actor TEXT NOT NULL
    CONSTRAINT ck_request_event_actor CHECK (
      actor IN ('client', 'admin', 'system')
    ),

  -- Compte responsable, obligatoire pour une action administrative. La suppression
  -- d'un compte ayant agi est refusée (RESTRICT) : les comptes sont désactivés,
  -- l'historique reste attribuable.
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

  -- Un événement appartient à UNE opération : jamais aux deux, jamais à aucune.
  -- La base refuse donc un événement orphelin, même inséré par erreur.
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
  id, quote_request_id, NULL, event_type, from_status, to_status,
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
-- 4. email_outbox : une file, deux origines possibles
-- ---------------------------------------------------------------------------
-- Même traitement que `request_events` : la file de notifications reçoit deux
-- colonnes de rattachement, dont une seule est remplie. M3Design reçoit donc un
-- courriel aussi bien pour un devis que pour un message de contact, à partir du
-- même mécanisme (mêmes états, mêmes tentatives, même purge).
--
-- Deux index uniques partiels sont ajoutés au passage : la base refuse désormais
-- elle-même la mise en file de DEUX notifications vivantes pour la même
-- opération, y compris sous concurrence. Leur condition est EXACTEMENT la règle
-- anti-doublon déjà appliquée par le code (`status IN ('pending','sending','sent')`) :
-- la seule façon de sortir de l'index est donc une issue définitive (envoi
-- annulé ou échec définitif), qui autorise un nouvel envoi — comportement
-- inchangé, mais garanti par la base.
CREATE TABLE email_outbox_v2 (
  id INTEGER PRIMARY KEY,

  -- Notification rattachée à une demande de devis OU à un message de contact :
  -- supprimer l'objet supprime sa notification (aucune donnée personnelle
  -- orpheline).
  quote_request_id INTEGER NULL
    REFERENCES quote_requests (id) ON DELETE CASCADE,
  contact_message_id INTEGER NULL
    REFERENCES contact_messages (id) ON DELETE CASCADE,

  -- Destinataire de la notification (donnée personnelle : jamais journalisée).
  recipient TEXT NOT NULL
    CONSTRAINT ck_email_outbox_recipient CHECK (
      recipient = lower(recipient)
      AND length(recipient) BETWEEN 6 AND 254
      AND recipient LIKE '%_@_%.__%'
    ),

  subject TEXT NOT NULL
    CONSTRAINT ck_email_outbox_subject CHECK (
      length(subject) BETWEEN 1 AND 200
    ),

  -- Corps en texte brut uniquement : pas de HTML, donc pas de contenu actif ni de
  -- suivi d'ouverture dans les courriels envoyés.
  body_text TEXT NOT NULL
    CONSTRAINT ck_email_outbox_body CHECK (
      length(body_text) BETWEEN 1 AND 20000
    ),

  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ck_email_outbox_status CHECK (
      status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')
    ),

  attempts INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_email_outbox_attempts CHECK (attempts BETWEEN 0 AND 20),

  -- Prochain essai : permet de repousser un envoi sans le perdre.
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Dernier message technique d'échec (nettoyé : ni destinataire, ni contenu).
  last_error TEXT NULL
    CONSTRAINT ck_email_outbox_last_error CHECK (
      last_error IS NULL OR length(last_error) <= 500
    ),

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER NULL,

  CONSTRAINT ck_email_outbox_sent_at CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT ck_email_outbox_dates CHECK (
    sent_at IS NULL OR sent_at >= created_at
  ),

  -- Une notification appartient à UNE opération : jamais aux deux, jamais à
  -- aucune. Sans cette règle, une notification pourrait devenir orpheline.
  CONSTRAINT ck_email_outbox_owner CHECK (
    (quote_request_id IS NOT NULL AND contact_message_id IS NULL)
    OR (quote_request_id IS NULL AND contact_message_id IS NOT NULL)
  )
);

INSERT INTO email_outbox_v2 (
  id, quote_request_id, contact_message_id, recipient, subject, body_text, status,
  attempts, next_attempt_at, last_error, created_at, sent_at
)
SELECT
  id, quote_request_id, NULL, recipient, subject, body_text, status,
  attempts, next_attempt_at, last_error, created_at, sent_at
FROM email_outbox;

DROP TABLE email_outbox;
ALTER TABLE email_outbox_v2 RENAME TO email_outbox;

-- Une seule notification vivante par demande de devis.
CREATE UNIQUE INDEX ux_email_outbox_quote_request
  ON email_outbox (quote_request_id)
  WHERE quote_request_id IS NOT NULL
    AND status IN ('pending', 'sending', 'sent');

-- Une seule notification vivante par message de contact.
CREATE UNIQUE INDEX ux_email_outbox_contact_message
  ON email_outbox (contact_message_id)
  WHERE contact_message_id IS NOT NULL
    AND status IN ('pending', 'sending', 'sent');

-- File d'attente : notifications à traiter maintenant ou plus tard.
CREATE INDEX ix_email_outbox_status_next_attempt
  ON email_outbox (status, next_attempt_at);

-- Politique de conservation : purge des notifications envoyées.
CREATE INDEX ix_email_outbox_created_at ON email_outbox (created_at);
