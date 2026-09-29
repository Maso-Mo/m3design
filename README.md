# M3Design

Site vitrine d'architecture : une seule page publique (`/`), avec navigation par
ancres (Hero, À propos, Services, Projets, Processus, Garantie, Contact).

Pile technique : React 19, Vite 8, TypeScript 6, Tailwind CSS 4, GSAP pour les
animations de défilement, Oxlint et Prettier. Côté serveur : Cloudflare Workers,
Hono, la base D1 et Resend pour les notifications.

> État actuel (V1) : le BACKEND est complet — formulaires publics sans
> vérification par code (nom et adresse électronique requis, téléphone
> facultatif), protections anti-abus, file `email_outbox` et envoi périodique
> (voir `worker/README.md`). Côté FRONT, le design global et la navigation sont
> en place : jetons de thème clair/sombre, typographie, composants d'interface,
> barre de navigation et ossature de la page. Les CONTENUS des sections, les
> animations et le formulaire client restent à développer.

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
  components/ui/          Button, Container, Section, SectionPlaceholder,
                          ThemeToggle
  data/                   contenus locaux typés (V1), dont data/site.ts
                          (identité, sections, navigation)
  hooks/                  useTheme (thème clair/sombre),
                          useActiveSection (section en cours de lecture)
  lib/                    cn (composition des classes Tailwind),
                          theme (logique de thème, hors React)
  services/content/       contrat de contenu et implémentation locale
                          (base de la V2 administrable)
  styles/globals.css      point d'entrée Tailwind ET design system (jetons de
                          couleur, de typographie, de rythme et de mouvement)
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

## Design global et navigation

Le socle visuel est défini **une seule fois**, dans `src/styles/globals.css` :
c'est là que vivent les couleurs, la typographie, le rythme vertical et la courbe
de transition. Les composants n'emploient ensuite que des noms de rôle
(`bg-canvas`, `text-muted`, `border-line`, `text-accent-ink`…), jamais une
valeur de couleur en dur : changer un thème, ou la teinte d'accent, se fait donc
en un seul endroit.

- **Palette** : blanc, noir et gris neutres, plus un unique accent — le rouge de
  la marque (`#ff1018`, relevé sur `public/images/branding/favicon.svg`). Aucun
  doré. Deux variantes de ce rouge coexistent à dessein : l'une pour les fonds
  de bouton (contraste suffisant avec du texte blanc), l'autre pour le rouge
  employé comme texte, sur chacun des deux thèmes.
- **Thèmes clair et sombre** : le thème sombre est piloté par une classe
  `.dark` sur `<html>`, posée AVANT le premier rendu par un court script en
  ligne dans `index.html` (donc aucun flash au chargement : ni fond blanc
  fugace, ni bascule visible). Le choix du visiteur est mémorisé, et tant qu'il
  n'a pas choisi, le site suit la préférence du système. `src/lib/theme.ts`
  contient la logique et `useTheme` la rend réactive ; le document reste la
  source de vérité.
- **Typographie** : deux familles, un rôle chacune — titres en serif (registre
  éditorial), texte courant en sans. Aucun fichier de police n'étant fourni
  dans le dépôt, ces piles s'appuient sur les polices du système : aucun appel
  réseau et aucun clignotement de police. Le jour où des polices de marque
  seront livrées, seules deux lignes changent.
- **Navigation** : une barre collante, transparente en toutes circonstances —
  aucun fond, aucun filet, aucune ombre, aucun flou, quel que soit le
  défilement : le bandeau passe dessous, comme sur la maquette. Le logotype est
  l'image de marque fournie, encadrée au plus juste
  (`logos-light-trim.png` / `logos-dark-trim.png`), une variante par thème, et
  son verrou vertical est complet : le nom s'y lit en entier. Elle reprend les
  liens des sections et le bouton de contact ; en dessous de `lg`, les liens
  passent dans un panneau vertical (fermeture par Échap, par un clic, ou au
  retour sur grand écran). La section en cours de lecture est soulignée.
- **Bandeau d'accueil** : la section remonte sous la barre de navigation
  (`pt-header -mt-header`) et ne dépasse pas la hauteur NATURELLE de la
  photographie à cette largeur (`min-h-[min(100svh,56.25vw)]`, l'image étant en
  16/9) : une hauteur d'écran sur un écran plus haut que large, et sinon la
  photographie dans toute sa largeur, sans agrandissement, déformation ni
  recadrage arbitraire (calage `object-[62%_center]`, qui garde le sujet dans le
  cadre quand la fenêtre est étroite). Le mot « M3DESIGN » est du TEXTE, jamais
  une image : sa taille suit la largeur de sa colonne (`19.5cqw`, dans un
  conteneur `@container`), si bien qu'il occupe la même proportion du mobile au
  très grand écran ; « M3 » porte le rouge de la marque, « Design » reste un
  fantôme à 18 %. Le sujet repasse DEVANT ce mot : une copie exacte de la
  photographie et de ses voiles, posée au-dessus du contenu, est évidée par une
  ellipse centrée sur le visage (`mask-image`) — la découpe ne se voit donc pas
  sur l'image, elle n'efface que les lettres qu'elle recouvre. Trois voiles,
  tous bâtis sur `canvas` (un voile général, une montée depuis le bas pour la
  transition, un dégradé de la gauche vers la droite), laissent la photographie
  visible à ≈ 50 % dans la moitié droite et à ≈ 25 % derrière le bloc
  éditorial, en clair comme en sombre — valeurs relevées par mesure sur le
  rendu, pas estimées. Sous `xl`, la photographie se montre entière alors que le
  bloc éditorial, lui, garde sa largeur : le texte tombe alors sur la partie
  sombre de l'image, où le rouge et le gris moyen ne se détachent plus. Un
  quatrième voile de `canvas`, débordant et fondu par le flou, éclaircit donc le
  fond DERRIÈRE le texte seulement, et s'efface dès que la mise en page à deux
  colonnes ramène le texte sur la partie claire de l'image. Contraste mesuré
  (fond réel, texte masqué pour la mesure) : titre 15,4:1 en clair et 15,8:1 en
  sombre, phrase de positionnement 5,0:1 et 7,9:1 ; le rouge du titre, texte de
  grande taille, reste à 2,75:1 sur le bandeau large en thème clair — le seul
  point sous le seuil de 3:1, tenu par le rouge de marque lui-même.
- **Images** : les paires fournies sont utilisées telles quelles, une variante
  par thème (`hero-light.jpg` et `hero-dark.jpg`, `about-light.png` et
  `about-dark.jpg`). Les assets de `public/images/` ne sont ni renommés ni
  déplacés, à deux exceptions près, signalées ici : le logotype a été recadré au
  plus juste (`logos-light-trim.png`, `logos-dark-trim.png`), et la paire du
  bandeau d'accueil a été remplacée par la version haute définition fournie
  (1672 × 941) — l'affiche en anglais visible dans le décor fait partie de la
  PHOTOGRAPHIE, comme le reste du décor. Aucun texte n'est en revanche composé
  dans les images : tout le texte du bandeau (métiers, titre, phrase de
  positionnement, manifeste) est du HTML et du CSS, donc traduisible,
  sélectionnable et lisible par les technologies d'assistance.

Dépôt local uniquement : aucun dépôt distant n'est configuré et aucun push n'est
effectué. `.gitignore` exclut les secrets (`.env*`, `.dev.vars*`), les artefacts
de build (`dist/`), les caches (`.vite*`, `*.tsbuildinfo`) et l'état local de
Cloudflare (`.wrangler/`).

## Suite prévue

1. Fondations : contenus locaux typés et socle visuel — **fait**.
2. Backend V1 : formulaires publics (nom et adresse électronique requis,
   téléphone facultatif), protections anti-abus, notifications par courriel —
   **fait** (voir `worker/README.md`).
3. Design global et navigation : jetons de thème et de typographie, composants
   d'interface, barre de navigation, ossature de la page — **fait**.
4. Sections visuelles : contenu des sept sections (Hero, À propos, Services,
   Projets, Processus, Garantie, Contact) — **bandeau d'accueil, en-tête et À
   propos faits**, les cinq autres sections restent **à faire**. Les contenus
   structurants encore en attente d'arbitrage (polices de marque, photographies
   homogènes, coordonnées réelles, mentions légales) le restent : ils
   n'empêchent pas la suite du travail.
5. Animations de défilement (GSAP) — **à faire**.
6. Formulaire de contact et demande de devis reliés aux routes de l'API —
   **à faire**.
