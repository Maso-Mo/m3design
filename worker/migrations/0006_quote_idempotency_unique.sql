-- ---------------------------------------------------------------------------
-- M3Design — schéma D1, migration 0006
-- Unicité de la clé d'idempotence des demandes de devis
-- ---------------------------------------------------------------------------
-- Pourquoi cette migration : la clé d'idempotence servait déjà à détecter le
-- rejeu d'un envoi (« cette demande a déjà été enregistrée »), mais elle n'était
-- protégée que par une vérification applicative (lecture puis écriture). Deux
-- envois simultanés du même formulaire pouvaient donc tous deux ne rien trouver,
-- puis créer chacun leur demande : doublon de dossier commercial et double
-- notification au client. L'index unique ci-dessous fait de cette règle une
-- garantie de la base, valable même sous concurrence.
--
-- Effet attendu côté application : une insertion qui perd la course échoue avec
-- « UNIQUE constraint failed: quote_requests.idempotency_key », traduit en
-- `idempotency_key_reused` par worker/src/db/errors.ts ; le dépôt renvoie alors la
-- demande déjà enregistrée avec `replayed: true` (voir createQuoteRequest).
--
-- Aucune donnée personnelle n'est concernée : la clé d'idempotence est un
-- identifiant technique aléatoire fourni par le client, sans lien avec l'identité
-- du demandeur.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX ux_quote_requests_idempotency_key
  ON quote_requests (idempotency_key);
