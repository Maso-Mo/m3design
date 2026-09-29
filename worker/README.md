# Worker — API M3Design

API du site, exécutée par Cloudflare Workers et écrite avec Hono. Elle est servie
sur le même domaine que le front : le build produit à la fois le Worker et les
assets statiques, et le serveur de développement exécute les deux ensemble.

## Comportement attendu

| Chemin              | Réponse                                                 |
| ------------------- | ------------------------------------------------------- |
| `POST /api/devis`   | `201` demande de devis enregistrée (formulaire simple)  |
| `POST /api/contact` | `201` message de contact enregistré (formulaire simple) |
| `GET /api/health`   | `200` JSON `{ "status": "ok", … }` (supervision, tests) |
| `/api/*` inconnu    | `404` JSON `{ "error": { "code": "not_found", … } }`    |
| hors `/api/*`       | assets statiques, `index.html` pour les URL inconnues   |

Aucune route n'envoie de courriel : soumettre une demande ENREGISTRE et met la
notification en file. L'envoi appartient au traitement périodique du Worker (voir
« Notification des demandes » plus bas).

Trois garanties viennent de `wrangler.jsonc` :

- `assets.run_worker_first: ["/api/*"]` : le Worker répond avant les assets sur
  `/api/*`. Une route d'API inexistante renvoie donc toujours du JSON, jamais la
  page HTML du front, même demandée depuis la barre d'adresse du navigateur.
- `assets.not_found_handling: "single-page-application"` : les URL inconnues
  (`/devis/confirmation`, `/admin/...`) reçoivent `index.html` et sont routées
  côté client.
- `triggers.crons: ["*/5 * * * *"]` : le Worker est invoqué toutes les cinq minutes
  sur son handler `scheduled`, qui vide la file des notifications. La fréquence se
  change là, sans toucher au code.

## Structure

```text
wrangler.jsonc              configuration Cloudflare (versionnée, sans secret)
tsconfig.worker.json        configuration TypeScript du Worker (strict, sans DOM)
worker-configuration.d.ts   types du runtime, générés par `pnpm generate:types`
worker/src/index.ts         point d'entrée : handlers `fetch` et `scheduled`
worker/src/app.ts           assemblage de l'API Hono (routes /api, 404, erreurs)
worker/src/scheduled.ts     traitement périodique : fournisseur, envoi, purge
worker/src/types.ts         AppEnv (bindings et variables de contexte Hono)
worker/src/routes/          une route par domaine : health, devis, contact
worker/src/services/        règles métier : devis, contact, notifications, anti-abus
                            (abuse-guard), file d'envoi (email-dispatch),
                            champs et références
worker/src/db/              accès D1 : client, erreurs, dépôts par table
worker/src/providers/       sorties externes : courriel (Resend, binding
                            Cloudflare), sélection des fournisseurs
worker/migrations/          schéma D1, une migration par étape, jamais modifiée
worker/tests/               tests d'intégration (vraie base locale, aucun réseau)
worker/tests/real-send.*    outils MANUELS d'envoi réel : dépôt d'une demande de
                            test, puis envoi ciblé (neutralisés par défaut)
```

## Ajouter une route

1. Créer `worker/src/routes/<domaine>.ts` — un fichier par domaine : `devis.ts`,
   `contact.ts`, `admin.ts`.
2. La monter dans `src/app.ts` avec `app.route('/api', <route>)`.
3. Renvoyer les erreurs avec `apiError()` pour conserver un format unique.
4. Vérifier : `pnpm typecheck`, puis `pnpm dev` et un appel `curl`.

## Notification des demandes

Une demande reçue est une demande dont M3Design est prévenu. C'est pourquoi la
notification fait partie de l'acceptation : la demande (ou le message), son
événement de création et sa mise en file (`email_outbox`) sont écrits dans le MÊME
lot, donc en tout ou rien. Une configuration d'envoi incomplète fait échouer la
soumission AVANT toute écriture : rien n'est enregistré, et le visiteur peut
resoumettre après correction.

### Champs du formulaire

Les deux formulaires acceptent exactement les mêmes champs, ce qui évite qu'ils
divergent :

| Champ                      | Obligatoire | Remarque                                              |
| -------------------------- | ----------- | ----------------------------------------------------- |
| `name`                     | oui         | 1 à 120 caractères                                    |
| `email`                    | oui         | forme vérifiée, mise en minuscules                    |
| `phone`                    | non         | forme internationale exigée si renseigné (E.164)      |
| `description` ou `message` | oui         | 10 à 2000 caractères                                  |
| `idempotencyKey`           | non         | générée par le serveur si absente                     |
| `website`                  | —           | champ LEURRE : doit rester vide (voir « Anti-abus »)  |
| `turnstileToken`           | non         | exigé seulement si le défi est configuré côté serveur |

Le téléphone n'est **jamais** présenté comme vérifié : il n'est qu'un moyen de
rappeler le visiteur. Une demande sans téléphone est parfaitement recevable.

### Contenu du courriel

Le courriel dit de quel type de demande il s'agit (`Nouvelle demande de devis` ou
`Nouveau message de contact`), puis donne ce qu'il faut pour traiter :

- la **référence publique** (également dans le sujet, pour retrouver la demande sans
  l'ouvrir) et la date de réception, en UTC ;
- le **nom** et l'**adresse électronique** du demandeur ;
- son **téléphone**, s'il l'a renseigné, présenté comme un simple moyen de rappel ;
- la description du besoin (devis) ou le message (contact).

Il ne contient **jamais** : le numéro tel qu'il a été saisi (la forme normalisée est
la seule qui fasse foi, et deux écritures du même numéro n'apportent rien au
traitement), ni aucun élément technique (identifiant interne, empreinte, secret).
Le corps est du **texte brut** : pas de HTML, donc pas de contenu actif ni de suivi
d'ouverture. Le nom, l'adresse et le texte n'apparaissent jamais dans les journaux
ni dans la réponse HTTP : seuls la référence publique et un numéro masqué sortent.

### Cycle de vie d'une entrée

```text
pending ──prise──▶ sending ──succès──▶ sent
   ▲                  │
   └─────échec────────┘ (essai repoussé, puis `failed` au plafond)
```

- **Prise sous bail** : une seule instruction SQL conditionnelle, donc atomique.
  Deux passages simultanés ne peuvent pas prendre la même entrée ; le perdant
  n'envoie rien. C'est ce qui empêche deux envois simultanés du même courriel.
- **Bail** : l'entrée redevient prenable `next_attempt_at` passé. Un traitement
  interrompu (limite de temps du Worker, redéploiement) ne bloque donc pas la file.
  Le bail dépasse largement le délai maximal d'un appel au fournisseur, donc en
  marche normale une entrée n'est jamais reprise pendant son envoi.
- **Tentatives** : un essai est compté par appel RÉEL au fournisseur, et une seule
  fois (à la prise). Au plafond (`EMAIL_MAX_ATTEMPTS`, 5 par défaut), l'entrée est
  abandonnée en `failed` — visible, jamais supprimée en silence.
- **Attente entre deux essais** : le délai annoncé par le fournisseur s'il est
  exploitable, sinon la progression du projet (1 min, 5 min, 15 min, 1 h, 2 h).

Deux précisions de vocabulaire, importantes pour lire la base et les journaux :

- `sent` signifie que le fournisseur a ACCEPTÉ le message et en a renvoyé un
  identifiant. Ce n'est ni une remise au destinataire, ni une lecture ; la remise
  relève des notifications du fournisseur, canal qui n'est pas mis en place ici.
- une ligne dans `email_outbox` n'est PAS un courriel envoyé. Seul le passage de
  l'entrée en `sent`, avec un identifiant de message, l'atteste.

### Conservation

Le passage périodique purge les notifications acceptées depuis plus de **trente
jours** : l'adresse du destinataire et le texte du message disparaissent alors de
la file. Une entrée en attente ou en échec n'est jamais purgée. Trente jours est la
durée retenue pour la mise en service (de quoi enquêter après coup, sans transformer
la file en journal de données personnelles) ; elle se change en tête de
`worker/src/scheduled.ts` (`SENT_NOTIFICATION_RETENTION_SECONDS`).

## Anti-abus des formulaires publics

Les formulaires sont ouverts : il n'y a plus de vérification par code. Trois
protections se superposent, dans cet ordre, et aucune ne demande de donnée
supplémentaire au visiteur :

1. **Validation stricte** (`services/request-fields.ts`) : bornes de longueur, motifs
   d'adresse électronique et de téléphone, clé d'idempotence à alphabet technique.
   Rien de ce qui n'est pas exploitable n'atteint la base.
2. **Champ leurre** : le champ `website` doit rester vide. Un visiteur ne le voit pas
   (masqué en CSS, hors navigation clavier) ; un robot qui remplit tout le formulaire
   se dénonce. La soumission est refusée, et la tentative est comptée.
3. **Limitation de débit** (`services/abuse-guard.ts`) : les tentatives sont
   comptées par fenêtre glissante, sur des empreintes HMAC (`RATE_LIMIT_SECRET`) —
   jamais sur les valeurs, qui ne sont donc pas stockées.

| Cible                | Plafond par défaut | Fenêtre | Pourquoi                                                         |
| -------------------- | ------------------ | ------- | ---------------------------------------------------------------- |
| adresse réseau       | 20                 | 1 h     | volontairement large : plusieurs visiteurs partagent une adresse |
| adresse électronique | 5                  | 24 h    | le vrai frein : une boîte ne se multiplie pas à l'infini         |
| téléphone            | 5                  | 24 h    | si le visiteur en a donné un                                     |

Le plafond par adresse réseau est délibérément GÉNÉREUX : bloquer un bureau, un
réseau public ou un opérateur mobile serait une faute commerciale, alors qu'un
dépassement des plafonds par adresse électronique ou par téléphone est, lui, le
signal d'un abus. Un dépassement répond `429` avec `Retry-After` et le nombre de
secondes à attendre (`too_many_requests`) ; rien n'est écrit en base.

4. **Défi anti-robot Turnstile (facultatif)** : dès que `TURNSTILE_SECRET` est
   configuré, un jeton `turnstileToken` est exigé et vérifié auprès de Cloudflare.
   Un jeton absent ou refusé répond `challenge_failed` (400) ; une panne de Cloudflare
   répond `service_unavailable` (503), car ce n'est pas la faute du visiteur. Le
   widget n'existe pas encore côté front : le défi est donc INACTIF aujourd'hui, et
   s'activera sans changement de code le jour où le formulaire React enverra un jeton.

## Envoi réel : ce qui reste à configurer

Tant que rien n'est configuré, la file se remplit sans jamais envoyer : le passage
périodique est ANNULÉ avant toute écriture, avec un motif dans les journaux
(`pass_skipped`, code `email_provider_missing`). Aucune notification n'est perdue.

**Fournisseur retenu pour les premiers tests : Resend** (`EMAIL_PROVIDER=resend`).
Le second fournisseur, `cloudflare`, est implémenté et documenté plus bas ; il
exige un domaine géré par Cloudflare et n'est donc pas utilisable tout de suite.

| Fournisseur  | Coût                 | Ce qu'il exige                                                                                        |
| ------------ | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `resend`     | gratuit (3 000/mois) | un compte Resend, une clé d'API, une adresse d'expédition autorisée                                   |
| `cloudflare` | gratuit              | un domaine géré par Cloudflare, Email Routing actif, adresse d'expédition créée, destinataire vérifié |

Le code refuse tout autre nom, y compris les doubles de test (`console`, `fake`,
`mock`, `mailhog`…) : un fournisseur fictif accepterait tout sans rien envoyer.

### Réglages par défaut

Aucune variable n'est nécessaire pour eux : 5 tentatives d'envoi au maximum, 10
notifications par passage, passage toutes les 5 minutes (`triggers.crons` de
`wrangler.jsonc`), conservation 30 jours. Les deux premiers se règlent par
`EMAIL_MAX_ATTEMPTS` et `EMAIL_DISPATCH_BATCH_SIZE` (voir `.dev.vars.example`).

### Resend, pas à pas

1. **Préparer les accès** : créer le compte Resend, puis une clé d'API. En mode
   test, Resend n'écrit qu'à l'adresse du compte : expédier depuis
   `onboarding@resend.dev` suffit donc pour recevoir un premier courriel, sans
   vérifier de domaine. Pour écrire à d'autres destinataires, il faudra vérifier un
   domaine et expédier depuis une adresse de ce domaine.

2. **Renseigner `.dev.vars`** (fichier ignoré par Git — aucun de ces noms ne doit
   apparaître dans `wrangler.jsonc`, qui est versionné) :

   ```dotenv
   EMAIL_PROVIDER=resend
   EMAIL_FROM_ADDRESS=onboarding@resend.dev   # adresse d'expédition, en minuscules
   EMAIL_FROM_NAME=M3Design                   # nom affiché, facultatif
   RESEND_API_KEY=…                           # SECRET : jamais dans le dépôt
   NOTIFICATION_EMAIL=…                       # boîte qui reçoit les demandes
   ```

3. **Préparer la base locale et obtenir UNE notification en attente**, dont on note
   la référence publique :

   ```bash
   pnpm db:migrate:local
   ```

   Deux cas, selon ce qui est disponible :

   - le parcours habituel : lancer `pnpm dev`, déposer une demande depuis le site et
     noter la référence affichée à l'écran ;
   - tant que le frontend n'est pas branché sur l'API, déposer une demande de TEST
     dans la base de DÉVELOPPEMENT seulement. Cette commande n'envoie rien, écrit une
     demande et sa notification par le même code que l'application, et affiche la
     référence à utiliser :

     ```bash
     EMAIL_SEED=1 pnpm vitest run worker/tests/real-send.seed.manual.test.ts
     ```

     Les données déposées sont étiquetées comme un test (numéro de test, description
     « Jeu de test local ») : le courriel reçu se reconnaît au premier coup d'œil.
     Le but de cet essai est de valider le TRANSPORT (file puis Resend), pas le
     parcours client complet.

4. **Envoyer pour de bon**, en le décidant explicitement et en désignant la
   référence de cette demande. Le test travaille uniquement sur la base locale de
   développement et sur `.dev.vars` : il envoie un VRAI courriel, et c'est le seul
   test qui le fait (sans la variable, il est neutralisé) :

   ```bash
   EMAIL_REAL_SEND=1 EMAIL_REAL_SEND_REFERENCE=DEV-2027-XXXXXXXX \
     pnpm vitest run worker/tests/real-send.manual.test.ts
   ```

   Avant d'envoyer, ce test vérifie lui-même cinq choses, et refuse de continuer
   sinon :

   - il n'ouvre que la base LOCALE (`getPlatformProxy` ne connaît aucune base
     distante) et refuse de tourner si `ENVIRONMENT=production` ;
   - la référence est obligatoire, bien formée, et doit correspondre à une
     notification encore en attente dans la file ;
   - le destinataire de l'entrée est bien celui de `NOTIFICATION_EMAIL`, et
     l'expéditeur celui de `EMAIL_FROM_ADDRESS` ;
   - son journal ne contient ni clé d'API, ni adresse complète (destinataire
     masqué), ni sujet, ni contenu de message ;
   - après l'envoi, il relit TOUTE la file et vérifie qu'aucune autre entrée n'a
     bougé : les anciennes demandes en attente restent en attente, sans essai
     supplémentaire.

5. **Interpréter le résultat**, avec la bonne conclusion :

   - l'entrée passe en `sent` parce que Resend a **ACCEPTÉ** le message et renvoyé
     son identifiant. C'est tout ce que la ligne prouve ;
   - cela ne prouve **pas** la réception : seul l'accusé de réception dans la boîte
     (courrier indésirable compris) l'atteste, et il peut arriver avec du retard ;
   - si le test échoue, l'issue affichée dit pourquoi (`retried` avec un code
     technique tel que `auth_failed` ou `invalid_recipient`, ou `not_claimable`),
     et l'entrée reste dans la file pour un nouvel essai.

6. **Contrôler en base** si besoin :

   ```bash
   pnpm wrangler d1 execute DB --local \
     --command "SELECT id, status, attempts, sent_at, last_error FROM email_outbox"
   ```

En ligne, les mêmes valeurs sont posées avec `wrangler secret put` (voir ci-dessous),
et le passage périodique prend le relais sans autre intervention.

### Variante : Email Routing (Cloudflare)

Sans tiers, sans clé, mais il faut un domaine géré par Cloudflare : activer Email
Routing, créer l'adresse d'expédition (`notifications@…`), vérifier la boîte de
destination, puis déclarer le binding dans `wrangler.jsonc`
(`"send_email": [{ "name": "EMAIL" }]`) et relancer `pnpm generate:types`. Il suffit
alors de mettre `EMAIL_PROVIDER=cloudflare` : rien d'autre ne change dans le code.

## Configuration et secrets

`wrangler.jsonc` est versionné : il ne contient ni identifiant de compte, ni
identifiant de base de données, ni secret, ni adresse de notification.

- En local : copier `.dev.vars.example` en `.dev.vars` (ignoré par Git).
- En ligne : `wrangler secret put <NOM>` pour les secrets, section `vars` de
  `wrangler.jsonc` pour les valeurs non sensibles.
- `NOTIFICATION_EMAIL` est la boîte qui reçoit les demandes. Elle est lue à la
  soumission et recopiée sur chaque notification : remplacer l'adresse temporaire de
  développement (retenue pour la mise en service, renseignée dans `.dev.vars`) par
  l'adresse officielle de M3Design ne demande donc AUCUNE modification du code. Elle
  n'est pas versionnée (une adresse personnelle dans un dépôt, c'est du démarchage
  assuré pour plus tard).
- `EMAIL_PROVIDER=resend` avec `EMAIL_FROM_ADDRESS` et `RESEND_API_KEY` : l'envoi
  réel des notifications (voir « Envoi réel » ci-dessus). La clé est un secret ;
  elle ne doit jamais apparaître ailleurs que dans `.dev.vars` ou dans un
  `wrangler secret put`.
- `RATE_LIMIT_SECRET` est OBLIGATOIRE : c'est lui qui rend non réversibles les
  empreintes de limitation d'abus. Sans lui, les formulaires répondent 503 plutôt que
  de laisser passer des soumissions sans contrôle. Il se génère par
  `openssl rand -hex 32` et se pose par `wrangler secret put RATE_LIMIT_SECRET`.
- `TURNSTILE_SECRET` est FACULTATIF : son absence désactive le défi anti-robot.
- La base D1 est déclarée dans `wrangler.jsonc` (`d1_databases`), avec un
  identifiant à remplacer par environnement.

Secrets et réglages attendus, tous documentés en détail dans `.dev.vars.example` :
`NOTIFICATION_EMAIL`, `EMAIL_PROVIDER`, `EMAIL_FROM_ADDRESS`, `RESEND_API_KEY`,
`RATE_LIMIT_SECRET`. Les autres variables (`TURNSTILE_SECRET`, délai d'appel au
fournisseur, plafond de tentatives d'envoi, taille de lot) sont optionnelles et
gardent des valeurs par défaut sûres. Il n'existe plus aucune variable OTP ni
WhatsApp : l'étape a été abandonnée (voir la migration 0008 ci-dessous).

## Migration 0008 : formulaires sans vérification

La migration `0008_forms_without_verification.sql` traduit l'abandon de WhatsApp et de
la vérification par code :

- `quote_requests` et `contact_messages` sont reconstruites sans `phone_verification_id`
  ni `phone_verified_at`, avec un état initial `new` (`new | in_progress | closed`) ;
- `request_events` est reconstruite (les anciens états `pending`/`verified` deviennent
  `new`) ; les valeurs HISTORIQUES restent lisibles, notamment
  `event_type = 'phone_verified'` ;
- `rate_limit_hits` reçoit les portées `quote_submit`, `contact_submit` et
  `admin_login` ;
- un index unique d'idempotence est ajouté sur `contact_messages` — l'unicité
  n'était garantie que par le service, donc vulnérable à deux envois simultanés ;
- `otp_challenges` est supprimée.

Les demandes antérieures ne sont pas modifiées par les nouvelles règles : la colonne
`intake_version` vaut `1` pour elles (elles peuvent donc ne pas avoir d'adresse
électronique, champ autrefois facultatif) et `2` pour les demandes du formulaire V1,
qui DOIVENT porter un nom, une adresse électronique et un texte — la base le garantit
(`ck_quote_intake_required`, `ck_contact_intake_required`).

### Incident d'application, et correctif

Lors de la PREMIÈRE application de cette migration sur la base de développement, la
**notification** et l'**événement** de la demande historique `DEV-2026-67WN93RJ` ont
été perdus. Cause exacte : SQLite exécute un DELETE implicite quand on supprime une
table parente, et les clés étrangères `ON DELETE CASCADE` d'`email_outbox` et de
`request_events` ont emporté ces lignes ; `PRAGMA defer_foreign_keys` reporte le
CONTRÔLE des contraintes, pas les ACTIONS de clé étrangère, et D1 refuse
`PRAGMA foreign_keys = OFF`.

Ce qui a été fait :

- la migration corrigée copie `email_outbox` et `request_events` dans des tables de
  passage AVANT toute reconstruction, puis les restaure à l'identique (identifiants,
  destinataires, dates, statuts) ; la restauration applique aussi la traduction
  d'états, sans quoi elle heurterait la nouvelle contrainte des événements ;
- `worker/tests/migrations.test.ts` reconstruit désormais, sur une base TEMPORAIRE, une
  base remplie d'avant 0008 (deux demandes, un message, trois événements, deux
  notifications) et vérifie ligne par ligne que tout est conservé. Aucune migration
  n'est validée tant que ce test ne passe pas ;
- la demande `DEV-2026-67WN93RJ` est TOUJOURS présente (référence, nom, description et
  statut `new` conservés). Les deux lignes perdues n'ont PAS été recréées : les
  réinventer avec des dates ou des contenus approximatifs aurait été plus trompeur
  qu'une absence assumée. La réception du courriel de test dans Gmail reste acquise,
  elle est indépendante de ces lignes locales.

## Types générés

`worker-configuration.d.ts` décrit le runtime (`Request`, `Response`, `fetch`,
`D1Database`, …) et l'interface `Env` déduite de `wrangler.jsonc`. Après toute
modification des bindings, des variables ou du point d'entrée, relancer :

```bash
pnpm generate:types
```

Le fichier est versionné mais exclu de Prettier (`.prettierignore`) : il
appartient à Wrangler.
