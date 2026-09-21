# Worker — API M3Design

API du site, exécutée par Cloudflare Workers et écrite avec Hono. Elle est servie
sur le même domaine que le front : le build produit à la fois le Worker et les
assets statiques, et le serveur de développement exécute les deux ensemble.

## Comportement attendu

| Chemin           | Réponse                                                 |
| ---------------- | ------------------------------------------------------- |
| `/api/health`    | `200` JSON `{ "status": "ok", … }` (supervision, tests) |
| `/api/*` inconnu | `404` JSON `{ "error": { "code": "not_found", … } }`    |
| hors `/api/*`    | assets statiques, `index.html` pour les URL inconnues   |

Deux garanties viennent de `wrangler.jsonc` :

- `assets.run_worker_first: ["/api/*"]` : le Worker répond avant les assets sur
  `/api/*`. Une route d'API inexistante renvoie donc toujours du JSON, jamais la
  page HTML du front, même demandée depuis la barre d'adresse du navigateur.
- `assets.not_found_handling: "single-page-application"` : les URL inconnues
  (`/devis/confirmation`, `/admin/...`) reçoivent `index.html` et sont routées
  côté client.

## Structure

```text
wrangler.jsonc             configuration Cloudflare (versionnée, sans secret)
tsconfig.worker.json       configuration TypeScript du Worker (strict, sans DOM)
worker-configuration.d.ts  types du runtime, générés par `pnpm generate:types`
worker/src/index.ts        point d'entrée : exporte l'application Hono
worker/src/app.ts          assemblage : routes sous /api, 404 JSON, erreurs
worker/src/types.ts        AppEnv (bindings et variables de contexte Hono)
worker/src/lib/api-error.ts  forme unique des réponses d'erreur
worker/src/routes/health.ts  GET /api/health
```

## Ajouter une route

1. Créer `worker/src/routes/<domaine>.ts` — un fichier par domaine : `otp.ts`
   (vérification du numéro WhatsApp), `contact.ts`, `devis.ts`, `admin.ts`.
2. La monter dans `src/app.ts` avec `app.route('/api', <route>)`.
3. Renvoyer les erreurs avec `apiError()` pour conserver un format unique.
4. Vérifier : `pnpm typecheck`, puis `pnpm dev` et un appel `curl`.

## Configuration et secrets

`wrangler.jsonc` est versionné : il ne contient ni identifiant de compte, ni
identifiant de base de données, ni secret.

- En local : copier `.dev.vars.example` en `.dev.vars` (ignoré par Git).
- En ligne : `wrangler secret put <NOM>` pour les secrets, section `vars` de
  `wrangler.jsonc` pour les valeurs non sensibles.
- `WHATSAPP_PROVIDER=console` est un fournisseur fictif réservé au développement
  et aux tests : le code devra le refuser lorsque `ENVIRONMENT=production`.
- La base D1 sera déclarée dans `wrangler.jsonc` (`d1_databases`) à l'étape
  correspondante, puis reportée dans les types par `pnpm generate:types`.

## Types générés

`worker-configuration.d.ts` décrit le runtime (`Request`, `Response`, `fetch`,
`D1Database`, …) et l'interface `Env` déduite de `wrangler.jsonc`. Après toute
modification des bindings, des variables ou du point d'entrée, relancer :

```bash
pnpm generate:types
```

Le fichier est versionné mais exclu de Prettier (`.prettierignore`) : il
appartient à Wrangler.
