-- ---------------------------------------------------------------------------
-- M3Design — schéma D1, migration 0001
-- Challenges de vérification du numéro (code reçu sur WhatsApp)
-- ---------------------------------------------------------------------------
-- Conventions du schéma (valables pour toutes les migrations) :
--   * les dates sont des entiers Unix en secondes (unixepoch()) : comparaisons
--     et index fiables, aucune ambiguïté de fuseau horaire ;
--   * les identifiants internes (id) ne sont jamais exposés au public : l'API
--     manipule la colonne reference des demandes ;
--   * le code envoyé au client n'est JAMAIS stocké en clair : seule son empreinte
--     HMAC-SHA-256 figure ici (code_hash). La génération, le hachage et la
--     comparaison se font exclusivement côté serveur ;
--   * aucune migration déjà appliquée n'est modifiée : les évolutions (V2)
--     s'ajoutent dans un nouveau fichier.
--
-- Cycle de vie d'un challenge, colonne status :
--   pending    : code envoyé, en attente de saisie ;
--   verified   : code correct, challenge consommé ;
--   failed     : trop de tentatives erronées ;
--   expired    : délai de validité dépassé ;
--   superseded : remplacé par un envoi plus récent pour le même numéro.
--
-- La colonne purpose restreint la portée d'un challenge à une seule opération :
-- une vérification obtenue pour une demande de devis ne peut pas servir ailleurs
-- (protection contre la réutilisation d'une preuve de vérification).
--
-- La colonne proof_valid_until porte la durée de validité de la PREUVE de
-- vérification (distincte de la validité du code) : elle est posée par le serveur
-- au moment de la vérification et contrôlée par un déclencheur de quote_requests,
-- ce qui empêche d'enregistrer une demande vérifiée avec une preuve périmée.
-- ---------------------------------------------------------------------------

CREATE TABLE otp_challenges (
  id INTEGER PRIMARY KEY,

  -- Numéro au format international (E.164), normalisé côté serveur.
  phone_normalized TEXT NOT NULL
    CONSTRAINT ck_otp_phone_format CHECK (
      length(phone_normalized) BETWEEN 8 AND 16
      AND phone_normalized GLOB '+[1-9]*'
      AND phone_normalized NOT GLOB '*[^+0-9]*'
    ),

  purpose TEXT NOT NULL
    CONSTRAINT ck_otp_purpose CHECK (purpose IN ('quote_request')),

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

-- Au plus UN challenge en attente par numéro et par opération : un renvoi de code
-- remplace l'ancien en une seule opération atomique. Cet index rend impossible la
-- multiplication des codes actifs pour un même numéro (abus et coûts d'envoi),
-- y compris en cas d'insertions concurrentes.
CREATE UNIQUE INDEX ux_otp_challenges_pending
  ON otp_challenges (phone_normalized, purpose)
  WHERE status = 'pending';

-- Comptage des envois par numéro sur une fenêtre de temps (limitation d'abus).
CREATE INDEX ix_otp_challenges_phone_created_at
  ON otp_challenges (phone_normalized, created_at);

-- Purge des challenges périmés.
CREATE INDEX ix_otp_challenges_expires_at ON otp_challenges (expires_at);
