-- ---------------------------------------------------------------------------
-- M3Design — schéma D1, migration 0005
-- Journal d'audit et contrôle des abus
-- ---------------------------------------------------------------------------
-- audit_log : trace des actions administratives sensibles (qui, quoi, quand, avec
-- quel résultat). La table ne contient aucune donnée personnelle : ni numéro, ni
-- adresse électronique, ni message client. Seule la référence publique d'une
-- entité est conservée, afin de pouvoir enquêter après un incident. La
-- suppression d'un compte ne détruit pas le journal (ON DELETE SET NULL) : la
-- trace des actions passées doit survivre au départ d'un administrateur.
--
-- rate_limit_hits : fondations du contrôle des abus. Aucune donnée en clair n'y
-- est écrite : la colonne key_hash contient une empreinte HMAC-SHA-256 (clé
-- secrète côté serveur) du numéro, de l'adresse ou du compte visé, ce qui permet
-- de compter les tentatives sans conserver d'identifiant de personne. Ces lignes
-- sont temporaires et destinées à la purge.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,

  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Nom technique de l'action, par exemple 'session.revoke' ou 'quote.close'.
  action TEXT NOT NULL
    CONSTRAINT ck_audit_log_action CHECK (length(action) BETWEEN 3 AND 80),

  entity_type TEXT NOT NULL
    CONSTRAINT ck_audit_log_entity_type CHECK (
      entity_type IN (
        'quote_request',
        'user',
        'session',
        'otp_challenge',
        'email_outbox',
        'system'
      )
    ),

  -- Référence publique de l'entité (par exemple DEV-2026-XXXXXXXX), jamais un
  -- numéro de téléphone ni une adresse électronique.
  entity_reference TEXT NULL
    CONSTRAINT ck_audit_log_entity_reference CHECK (
      entity_reference IS NULL OR length(entity_reference) <= 64
    ),

  outcome TEXT NOT NULL
    CONSTRAINT ck_audit_log_outcome CHECK (
      outcome IN ('success', 'failure', 'denied')
    ),

  actor_user_id INTEGER NULL REFERENCES users (id) ON DELETE SET NULL,

  -- Motif technique court (jamais un message client, jamais une donnée personnelle).
  reason TEXT NULL
    CONSTRAINT ck_audit_log_reason CHECK (
      reason IS NULL OR length(reason) <= 300
    )
);

CREATE INDEX ix_audit_log_occurred_at ON audit_log (occurred_at);

-- Enquête sur une entité précise (par exemple après une réclamation).
CREATE INDEX ix_audit_log_entity
  ON audit_log (entity_type, entity_reference, occurred_at);

-- Activité d'un compte (contrôle interne et détection d'abus de droits).
CREATE INDEX ix_audit_log_actor ON audit_log (actor_user_id, occurred_at);

CREATE TABLE rate_limit_hits (
  id INTEGER PRIMARY KEY,

  -- Nature de l'action limitée.
  scope TEXT NOT NULL
    CONSTRAINT ck_rate_limit_hits_scope CHECK (
      scope IN ('otp_send', 'otp_verify', 'quote_submit', 'admin_login')
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

-- Comptage des tentatives sur une fenêtre glissante.
CREATE INDEX ix_rate_limit_hits_scope_key_created_at
  ON rate_limit_hits (scope, key_hash, created_at);

-- Purge des lignes périmées.
CREATE INDEX ix_rate_limit_hits_created_at ON rate_limit_hits (created_at);
