import { createApp } from './app'
import { createScheduledHandler } from './scheduled'

/**
 * Point d'entrée du Worker.
 *
 * Deux façons d'être invoqué, deux responsabilités :
 *
 *   * `fetch` : l'application Hono, qui sert toute l'API sous `/api`. Elle
 *     ENREGISTRE les demandes et met les notifications en file ; elle n'envoie
 *     jamais de courriel ;
 *   * `scheduled` : le traitement périodique qui vide la file et envoie pour de
 *     bon (voir `src/scheduled.ts`). C'est la SEULE voie d'envoi : aucun client,
 *     aucune route ne peut déclencher un courriel.
 */
const app = createApp()

export default {
  fetch: app.fetch,
  scheduled: createScheduledHandler(),
}
