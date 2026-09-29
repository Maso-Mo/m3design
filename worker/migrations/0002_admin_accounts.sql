-- ---------------------------------------------------------------------------
-- M3Design — schéma D1, migration 0002
-- Comptes administratifs et sessions (fondations de l'administration V1)
-- ---------------------------------------------------------------------------
-- Aucune interface, aucune route et aucune authentification ne sont implémentées
-- à cette étape : seules les structures sont posées, afin que la V1 puisse les
-- utiliser sans refonte.
--
-- Règles de sécurité portées par le schéma :
--   * un mot de passe n'est jamais stocké : seule une empreinte au format
--     reconnu (chaîne de type PHC/modular crypt, commençant par « $ ») est
--     acceptée. Une valeur en clair est refusée par la base elle-même ;
--   * une session ne contient jamais son jeton : seule son empreinte SHA-256
--     hexadécimale est stockée ; un jeton révoqué ou expiré est refusé ;
--   * le second facteur est prévu (colonne totp_secret_encrypted) et son secret
--     devra être chiffré côté serveur : aucune valeur en clair n'est acceptée ici
--     par convention d'exploitation (le chiffrement arrive à l'étape
--     authentification) ;
--   * aucune donnée de suivi n'est conservée dans les sessions (ni adresse IP, ni
--     navigateur) : minimisation des données personnelles ;
--   * un compte n'est jamais supprimé mais désactivé (status = 'disabled') : le
--     journal d'audit et l'historique des demandes doivent rester attribuables.
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id INTEGER PRIMARY KEY,

  -- Adresse de connexion, toujours en minuscules (comparaison et unicité stables).
  email TEXT NOT NULL UNIQUE
    CONSTRAINT ck_users_email CHECK (
      email = lower(email)
      AND length(email) BETWEEN 6 AND 254
      AND email LIKE '%_@_%.__%'
    ),

  display_name TEXT NOT NULL
    CONSTRAINT ck_users_display_name CHECK (
      length(display_name) BETWEEN 1 AND 80
    ),

  -- Empreinte du mot de passe uniquement (jamais le mot de passe).
  password_hash TEXT NOT NULL
    CONSTRAINT ck_users_password_hash CHECK (
      length(password_hash) BETWEEN 20 AND 255
      AND password_hash GLOB '$*'
      AND password_hash GLOB '$*$*$*'
    ),

  -- Secret du second facteur, chiffré par le serveur. Préparé, non utilisé.
  totp_secret_encrypted TEXT NULL
    CONSTRAINT ck_users_totp CHECK (
      totp_secret_encrypted IS NULL
      OR length(totp_secret_encrypted) BETWEEN 16 AND 512
    ),

  status TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT ck_users_status CHECK (status IN ('active', 'disabled')),

  -- Protection contre les tentatives de connexion répétées (préparée).
  failed_login_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT ck_users_failed_login_count CHECK (failed_login_count >= 0),

  -- Verrouillage temporaire du compte après trop d'échecs.
  locked_until INTEGER NULL,

  last_login_at INTEGER NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

  CONSTRAINT ck_users_locked_until CHECK (locked_until IS NULL OR locked_until > 0),
  CONSTRAINT ck_users_last_login CHECK (
    last_login_at IS NULL OR last_login_at >= created_at
  ),
  CONSTRAINT ck_users_dates CHECK (updated_at >= created_at)
);

-- Recherche des comptes verrouillés (administration, surveillance des abus).
CREATE INDEX ix_users_status_locked_until ON users (status, locked_until);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,

  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Empreinte SHA-256 (hexadécimale) du jeton de session. Jamais le jeton.
  token_hash TEXT NOT NULL UNIQUE
    CONSTRAINT ck_sessions_token_hash CHECK (
      length(token_hash) = 64
      AND token_hash GLOB '[0-9a-f]*'
      AND token_hash NOT GLOB '*[^0-9a-f]*'
    ),

  created_at INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Une session a toujours une fin : durée de validité limitée.
  expires_at INTEGER NOT NULL,

  last_seen_at INTEGER NULL,

  -- Révocation explicite (déconnexion, changement de mot de passe, incident).
  revoked_at INTEGER NULL,

  CONSTRAINT ck_sessions_expires_at CHECK (expires_at > created_at),
  CONSTRAINT ck_sessions_last_seen CHECK (
    last_seen_at IS NULL OR last_seen_at >= created_at
  ),
  CONSTRAINT ck_sessions_revoked_at CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

-- Sessions actives d'un compte (liste et révocation en masse).
CREATE INDEX ix_sessions_user_expires_at ON sessions (user_id, expires_at);

-- Purge des sessions expirées ou révoquées.
CREATE INDEX ix_sessions_expires_at ON sessions (expires_at);
