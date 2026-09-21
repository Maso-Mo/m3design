/**
 * Contexte commun aux routes de l'API.
 *
 * `Bindings` reprend l'interface `Env` générée par `wrangler types` à partir de
 * wrangler.jsonc : les variables, secrets et futurs bindings (base D1, par
 * exemple) y apparaîtront automatiquement après `pnpm generate:types`.
 */
export type AppEnv = {
  Bindings: Env
}
