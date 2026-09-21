import { Hono } from 'hono'
import type { AppEnv } from '../types'

/**
 * État de l'API.
 *
 * Sert aux tests et à la supervision : la réponse ne révèle rien d'autre que le
 * fait que le Worker répond.
 */
export const healthRoute = new Hono<AppEnv>()

healthRoute.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'm3design-api',
    timestamp: new Date().toISOString(),
  }),
)
