import { Hono } from 'hono'
import { apiError } from './lib/api-error'
import { healthRoute } from './routes/health'
import type { AppEnv } from './types'

/**
 * Construit l'application Hono du Worker.
 *
 * Toute l'API est montée sous /api ; le reste des chemins est servi par les
 * assets statiques (le build du front). Cloudflare n'invoque le Worker en
 * premier que sur /api/* : voir assets.run_worker_first dans wrangler.jsonc.
 *
 * Routes prévues, une par fichier dans src/routes/ :
 *   - /api/otp/*    envoi et vérification du code reçu sur WhatsApp
 *   - /api/contact  messages du formulaire de contact
 *   - /api/devis    demandes de devis
 *   - /api/admin/*  administration (accès protégé)
 */
export function createApp() {
  const app = new Hono<AppEnv>()

  app.route('/api', healthRoute)

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
