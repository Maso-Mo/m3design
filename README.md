# M3Design

Site vitrine d'architecture : une seule page publique (`/`), avec navigation par
ancres (Hero, À propos, Services, Projets, Processus, Garantie, Équipe, Contact).

Pile technique : React 19, Vite 8, TypeScript 6, Tailwind CSS 4, GSAP pour les
animations de scroll, Oxlint et Prettier.

> État actuel : squelette du projet. Les sections visuelles, les contenus et le
> backend Cloudflare ne sont pas encore implémentés.

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

## Commandes disponibles

| Commande            | Effet                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `pnpm dev`          | Serveur de développement Vite (HMR)                                  |
| `pnpm build`        | Vérification des types (`tsc -b`) puis build de production (`dist/`) |
| `pnpm preview`      | Sert localement le build de production                               |
| `pnpm typecheck`    | Vérification des types uniquement, sans production de fichiers       |
| `pnpm lint`         | Analyse statique Oxlint                                              |
| `pnpm format`       | Formate le dépôt avec Prettier (écriture)                            |
| `pnpm format:check` | Vérifie le formatage sans écrire (usage CI)                          |

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
```

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
2. Backend : Cloudflare Workers, Hono et D1.
3. Formulaire sécurisé : vérification du numéro par code reçu sur WhatsApp,
   contrôlée côté serveur. Le fournisseur reste à sélectionner ; un fournisseur
   fictif est réservé au développement et aux tests, et refusé en production.
4. Développement des sections visuelles et des animations GSAP.
