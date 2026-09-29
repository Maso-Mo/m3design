-- ---------------------------------------------------------------------------
-- M3Design — schéma D1, migration 0004
-- Historique des demandes et file d'envoi des notifications
-- ---------------------------------------------------------------------------
-- request_events répond au besoin de traçabilité et de correction : chaque action
-- sur une demande y laisse une ligne (création, vérification du numéro, changement
-- d'état, correction, anonymisation). La table ne contient volontairement aucune
-- donnée personnelle : les numéros, noms et adresses restent dans quote_requests.
-- La colonne reason est un court motif d'exploitation (jamais un message client).
--
-- email_outbox est une file d'attente : les notifications sont écrites ici par le
-- serveur puis envoyées par un traitement ultérieur (aucun envoi à cette étape,
-- aucun fournisseur configuré). La ligne contient le destinataire : elle est donc
-- concernée par la politique de conservation et doit être purgée après envoi.
-- ---------------------------------------------------------------------------

CREATE TABLE request_events (
  id INTEGER PRIMARY KEY,

  -- Suppression de la demande : l'historique disparaît avec elle.
  quote_request_id INTEGER NOT NULL
    REFERENCES quote_requests (id) ON DELETE CASCADE,

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
  )
);

-- Historique chronologique d'une demande.
CREATE INDEX ix_request_events_request_created_at
  ON request_events (quote_request_id, created_at);

-- Activité d'un compte administratif (contrôle interne).
CREATE INDEX ix_request_events_actor_created_at
  ON request_events (actor_user_id, created_at);

CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY,

  -- Notification rattachée à une demande : si la demande est supprimée, la
  -- notification l'est aussi (aucune donnée personnelle orpheline).
  quote_request_id INTEGER NOT NULL
    REFERENCES quote_requests (id) ON DELETE CASCADE,

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
  -- suivi d'ouverture dans les courriels envoyés aux clients.
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
  )
);

-- File d'attente : notifications à traiter maintenant ou plus tard.
CREATE INDEX ix_email_outbox_status_next_attempt
  ON email_outbox (status, next_attempt_at);

-- Politique de conservation : purge des notifications envoyées.
CREATE INDEX ix_email_outbox_created_at ON email_outbox (created_at);
