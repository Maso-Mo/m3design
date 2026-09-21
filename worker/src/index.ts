import { createApp } from './app'

/**
 * Point d'entrée du Worker.
 *
 * Hono expose `fetch` : l'instance peut donc être exportée directement comme
 * handler par défaut du runtime Cloudflare.
 */
export default createApp()
