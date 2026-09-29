import { Hono } from 'hono'
import { apiError } from './lib/api-error'
import { createContactRoute } from './routes/contact'
import { createQuoteRoute } from './routes/devis'
import { healthRoute } from './routes/health'
import type { ContactRouteDependencies } from './routes/contact'
import type { QuoteRouteDependencies } from './routes/devis'
import type { AppEnv } from './types'

/**
 * Dépendances de l'application, injectables par les tests.
 *
 * Tout est facultatif : sans valeur injectée, chaque route lit l'environnement du
 * Worker (`c.env`). Les tests fournissent une horloge contrôlée, un secret de
 * limitation et un `fetch` factice pour le défi anti-robot : ils restent ainsi
 * déterministes, sans réseau et sans dépendre de `.dev.vars`.
 */
export type AppDependencies = QuoteRouteDependencies & ContactRouteDependencies

/**
 * Construit l'application Hono du Worker.
 *
 * Toute l'API est montée sous /api ; le reste des chemins est servi par les
 * assets statiques (le build du front). Cloudflare n'invoque le Worker en
 * premier que sur /api/* : voir assets.run_worker_first dans wrangler.jsonc.
 *
 * Routes montées, une par fichier dans src/routes/ :
 *   - POST /api/devis        demande de devis (formulaire simple)
 *   - POST /api/contact      message de contact (formulaire simple)
 *   - GET  /api/health       état de l'API
 *
 * Reste à écrire (voir worker/README.md) :
 *   - /api/admin/*  administration (accès protégé).
 */
export function createApp(dependencies: AppDependencies = {}) {
  const app = new Hono<AppEnv>()

  app.route('/api', healthRoute)
  app.route('/api', createQuoteRoute(dependencies))
  app.route('/api', createContactRoute(dependencies))

  // Chemin d'API inconnu : réponse JSON, jamais la page HTML du front.
  app.notFound((c) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      return apiError(
        c,
        404,
        'not_found',
        `Route inconnue : ${c.req.method} ${c.req.path}`,
      )
    }

    // Chemin hors API : les assets statiques (dont le repli vers index.html de la
    // page unique) sont normalement servis avant d'atteindre le Worker. Ce repli
    // conserve ce comportement si le Worker est tout de même appelé.
    return c.env.ASSETS.fetch(c.req.raw)
  })

  app.onError((error, c) => {
    console.error(
      `[api] erreur sur ${c.req.method} ${c.req.path}`,
      error instanceof Error ? error.message : error,
    )
    return apiError(c, 500, 'internal_error', "Erreur interne de l'API.")
  })

  return app
}
