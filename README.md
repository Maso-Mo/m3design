# M3Design

Site vitrine d'architecture : une seule page publique (`/`), avec navigation par
ancres (Hero, À propos, Services, Projets, Processus, Garantie, Équipe, Contact).

Pile technique : React 19, Vite 8, TypeScript 6, Tailwind CSS 4, GSAP pour les
animations de scroll, Oxlint et Prettier. Côté serveur : Cloudflare Workers et
Hono, avec la base D1 prévue à l'étape suivante.

> État actuel : squelette du projet. Les sections visuelles et les contenus ne
> sont pas encore implémentés ; le socle du backend (Worker Hono, route
> `/api/health`, configuration de déploiement) est en place.

## Prérequis

| Outil | Version requise        | Déclaration           |
| ----- | ---------------------- | --------------------- |
| Node  | 24.13.0 (min. 22.12.0) | `.nvmrc` et `engines` |
| pnpm  | 12.4.2                 | `packageManager`      |

```bash
nvm use          # applique la version de .nvmrc
corepack enable  # optionnel : respecte le champ packageManager
```

## Installation

```bash
pnpm install
```

pnpm 12 n'exécute aucun script d'installation par défaut. `pnpm-workspace.yaml`
autorise les seuls paquets qui en ont besoin (`esbuild` et `workerd`, qui
installent leur binaire natif) ; tout autre paquet reste bloqué. Ajouter une ligne
à cette liste est une décision de sécurité : vérifier le script avant d'autoriser.

## Commandes disponibles

| Commande              | Effet                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`            | Développement : front (HMR) et API (`/api/*`) dans le même processus   |
| `pnpm build`          | Types puis build : `dist/client/` (front) et `dist/m3design/` (Worker) |
| `pnpm preview`        | Exécute le build dans le runtime Workers, localement                   |
| `pnpm deploy`         | Build puis envoi sur Cloudflare (nécessite un compte configuré)        |
| `pnpm generate:types` | Régénère les types du runtime Workers depuis `wrangler.jsonc`          |
| `pnpm typecheck`      | Vérification des types uniquement, sans production de fichiers         |
| `pnpm lint`           | Analyse statique Oxlint                                                |
| `pnpm format`         | Formate le dépôt avec Prettier (écriture)                              |
| `pnpm format:check`   | Vérifie le formatage sans écrire (usage CI)                            |

## Qualité du code : deux outils, deux rôles

- **Oxlint** (`.oxlintrc.json`) : correction et bonnes pratiques
  (`react/rules-of-hooks`, `react/only-export-components`, catégorie
  `correctness`). Aucune règle de mise en forme n'est activée : il n'entre donc
  pas en conflit avec Prettier.
- **Prettier** (`.prettierrc.json`) : seule source de vérité pour la mise en
  forme (`semi: false`, `singleQuote: true`, `printWidth: 80`, `endOfLine: lf`).
  Les exclusions sont listées dans `.prettierignore`, notamment `pnpm-lock.yaml`
  dont le format appartient à pnpm.

Le plugin de tri des classes Tailwind (`prettier-plugin-tailwindcss`) n'est pas
installé à ce stade ; il pourra être ajouté ultérieurement.

## Variables d'environnement

| Fichier             | Portée                                  | Versionné |
| ------------------- | --------------------------------------- | --------- |
| `.env.example`      | variables publiques du front (`VITE_*`) | oui       |
| `.env.local`        | valeurs locales du front                | non       |
| `.dev.vars.example` | noms de la configuration du Worker      | oui       |
| `.dev.vars`         | valeurs locales des secrets du Worker   | non       |

Toute variable préfixée `VITE_` est intégrée au bundle et donc lisible par les
visiteurs : aucun secret ne doit y figurer. Les secrets du serveur sont fournis
au Worker par variables d'environnement et ne sont jamais commités.

## Structure du projet

```text
public/                   assets servis tels quels
  images/                 images par thème : about, branding, hero, process,
                          projects, services, team
src/
  components/layout/      Layout, Header, Footer
  components/projects/    ProjectCard, ProjectGrid
  components/sections/    les huit sections de la page
  components/ui/          Button, Container
  data/                   contenus locaux typés (V1)
  services/content/       contrat de contenu et implémentation locale
                          (base de la V2 administrable)
  styles/globals.css      point d'entrée Tailwind
  types/                  types partagés
worker/                   API Cloudflare Workers (Hono) — voir worker/README.md
  src/routes/             une route par domaine (health pour l'instant)
  src/lib/                utilitaires de l'API (format des erreurs)
wrangler.jsonc            configuration du Worker et des assets statiques
tsconfig.worker.json      TypeScript du Worker (strict, sans types DOM)
worker-configuration.d.ts types du runtime Workers, générés par Wrangler
```

## Backend et déploiement

L'API est un Worker Cloudflare écrit avec Hono, servi sous `/api/*` ; en
production, le même Worker sert aussi le front statique. Conventions et détails :
`worker/README.md`.

- `pnpm dev` suffit : le plugin Cloudflare pour Vite exécute le Worker dans le
  même processus que Vite. Aucun proxy ni second serveur n'est nécessaire.
- Une route `/api/*` inexistante répond en JSON (`404`) et jamais avec la page
  HTML du front ; toute autre URL inconnue reçoit `index.html` (page unique).
- Avant un premier déploiement, côté Cloudflare et hors du dépôt :
  authentification (`wrangler login` ou `CLOUDFLARE_API_TOKEN`), création du
  Worker, pose des secrets (`wrangler secret put ENVIRONMENT`), puis vérification
  de la configuration sans rien envoyer :
  `pnpm build && pnpm exec wrangler deploy --dry-run`.
- `wrangler.jsonc` ne contient aucun identifiant de compte, identifiant de base
  ni secret : ces valeurs sont propres à chaque environnement et restent hors du
  dépôt.

## Organisation des images

Les images de `public/images/` sont référencées par leurs noms actuels : elles
ne doivent être ni renommées ni déplacées.

## Git

Dépôt local uniquement : aucun dépôt distant n'est configuré et aucun push n'est
effectué. `.gitignore` exclut les secrets (`.env*`, `.dev.vars*`), les artefacts
de build (`dist/`), les caches (`.vite*`, `*.tsbuildinfo`) et l'état local de
Cloudflare (`.wrangler/`).

## Suite prévue

1. Fondations : contenus locaux typés et styles de base.
2. Backend : fondations en place (Worker Hono, route `/api/health`, configuration
   de déploiement). Restent la base D1, les routes métier et leur validation.
3. Formulaire sécurisé : vérification du numéro par code reçu sur WhatsApp,
   contrôlée côté serveur. Le fournisseur reste à sélectionner ; un fournisseur
   fictif est réservé au développement et aux tests, et refusé en production.
4. Développement des sections visuelles et des animations GSAP.
