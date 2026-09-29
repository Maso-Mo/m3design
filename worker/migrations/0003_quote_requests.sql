-- ---------------------------------------------------------------------------
-- M3Design — schéma D1, migration 0003
-- Demandes de devis
-- ---------------------------------------------------------------------------
-- Règle métier validée : UNE SEULE demande active par numéro normalisé ; une
-- nouvelle demande redevient possible une fois la précédente clôturée. Cette
-- règle est portée par un index unique partiel (et non par une vérification
-- applicative) : elle reste vraie même en cas d'insertions concurrentes.
--
-- Règle de sécurité : une demande ne peut PAS être enregistrée comme vérifiée
-- sans preuve de vérification valide. La preuve est la ligne de otp_challenges
-- consommée par le serveur après saisie du bon code (challenge.status =
-- 'verified'), liée au même numéro, à la même opération et encore dans sa fenêtre
-- de validité. Deux déclencheurs le vérifient dans la base elle-même : un champ
-- fourni par le navigateur ne suffit jamais.
--
-- Données personnelles : numéro (forme brute et normalisée), nom, adresse
-- électronique et description. Elles sont nécessaires au traitement commercial de
-- la demande, ne sont jamais exposées publiquement et peuvent être effacées
-- (anonymized_at) selon la politique de conservation, tout en conservant la
-- référence et les dates pour la comptabilité.
-- ---------------------------------------------------------------------------

CREATE TABLE quote_requests (
  id INTEGER PRIMARY KEY,

  -- Référence publique unique, communiquée au client (jamais l'identifiant id).
  reference TEXT NOT NULL UNIQUE
    CONSTRAINT ck_quote_reference_format CHECK (
      length(reference) BETWEEN 14 AND 32
      AND reference GLOB 'DEV-[0-9][0-9][0-9][0-9]-[0-9A-Z]*'
    ),

  -- Numéro normalisé côté serveur : sert à l'unicité des demandes actives.
  phone_normalized TEXT NULL
    CONSTRAINT ck_quote_phone_format CHECK (
      phone_normalized IS NULL
      OR (
        length(phone_normalized) BETWEEN 8 AND 16
        AND phone_normalized GLOB '+[1-9]*'
        AND phone_normalized NOT GLOB '*[^+0-9]*'
      )
    ),

  -- Numéro tel que saisi par le client : utile au support et aux corrections.
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

  -- pending     : reçue, numéro pas encore confirmé ;
  -- verified    : numéro confirmé côté serveur (preuve liée) ;
  -- in_progress : prise en charge commerciale ;
  -- closed      : traitée ou abandonnée (seul état qui libère le numéro).
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT ck_quote_status CHECK (
      status IN ('pending', 'verified', 'in_progress', 'closed')
    ),

  -- Preuve de vérification (ligne de otp_challenges consommée par le serveur).
  phone_verification_id INTEGER NULL
    REFERENCES otp_challenges (id) ON DELETE RESTRICT,

  phone_verified_at INTEGER NULL,

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

  -- Une demande vérifiée (ou plus avancée) doit porter une preuve de vérification.
  CONSTRAINT ck_quote_verified_requires_proof CHECK (
    status = 'pending'
    OR anonymized_at IS NOT NULL
    OR (phone_verified_at IS NOT NULL AND phone_verification_id IS NOT NULL)
  ),

  -- closed_at et status = 'closed' vont toujours ensemble.
  CONSTRAINT ck_quote_closed_at CHECK ((status = 'closed') = (closed_at IS NOT NULL)),

  -- Tant qu'une demande n'est pas anonymisée, les données nécessaires au
  -- traitement sont présentes.
  CONSTRAINT ck_quote_personal_data CHECK (
    anonymized_at IS NOT NULL
    OR (
      phone_normalized IS NOT NULL
      AND phone_raw IS NOT NULL
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
      AND phone_verification_id IS NULL
    )
  ),

  CONSTRAINT ck_quote_dates CHECK (
    updated_at >= created_at
    AND (closed_at IS NULL OR closed_at >= created_at)
    AND (anonymized_at IS NULL OR anonymized_at >= created_at)
    AND (phone_verified_at IS NULL OR phone_verified_at > 0)
  )
);

-- Une seule demande active par numéro normalisé : la règle métier est garantie
-- par la base, y compris sous concurrence. Les demandes clôturées (ou anonymisées)
-- sortent de l'index, ce qui autorise une nouvelle demande ensuite.
CREATE UNIQUE INDEX ux_quote_requests_active_phone
  ON quote_requests (phone_normalized)
  WHERE status <> 'closed';

-- Une preuve de vérification ne peut autoriser qu'UNE demande : le rejeu d'un
-- challenge consommé est refusé par la base elle-même.
CREATE UNIQUE INDEX ux_quote_requests_phone_verification
  ON quote_requests (phone_verification_id)
  WHERE phone_verification_id IS NOT NULL;

-- Suivi commercial (file d'attente par état).
CREATE INDEX ix_quote_requests_status_created_at
  ON quote_requests (status, created_at);

-- Historique par numéro (support, détection d'abus).
CREATE INDEX ix_quote_requests_phone_created_at
  ON quote_requests (phone_normalized, created_at);

-- Politique de conservation : balayage des demandes clôturées à anonymiser.
CREATE INDEX ix_quote_requests_closed_at
  ON quote_requests (closed_at)
  WHERE closed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Contrôle de la preuve de vérification (insertion et mise à jour)
--
-- Le message d'abandon est un jeton technique stable : le code applicatif s'y
-- appuie pour produire une erreur générique, sans jamais relayer le détail SQL ni
-- la moindre donnée personnelle au client.
-- ---------------------------------------------------------------------------
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
