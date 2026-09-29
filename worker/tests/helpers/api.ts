/**
 * Outils de test des routes HTTP.
 *
 * Les tests appellent l'application Hono en mémoire (`app.request`) : aucune socket
 * n'est ouverte, aucun déploiement n'a lieu, et l'environnement du Worker est
 * construit explicitement, valeur par valeur. Un test ne peut donc pas dépendre
 * d'un fichier `.dev.vars` ni d'un secret réel.
 *
 * L'environnement passé à `app.request` est l'ÉQUIVALENT de `c.env` : c'est
 * précisément ce que Hono accepte comme troisième argument. Un test peut ainsi
 * simuler une configuration incomplète (absence de `OTP_SECRET`, fournisseur non
 * nommé) sans toucher au code de production.
 */

import type { Hono } from 'hono'
import type { Db } from '../../src/db/client'
import type { AppEnv, WorkerVariables } from '../../src/types'

/**
 * Secret de limitation d'abus utilisé par les routes publiques des tests.
 *
 * Les formulaires refusent une soumission si le secret est absent (503) : une
 * valeur par défaut évite que chaque test doive la répéter, et un test peut la
 * retirer explicitement (`RATE_LIMIT_SECRET: ''`) pour vérifier ce refus.
 *
 * Sa LONGUEUR compte (32 caractères minimum, voir `services/abuse-guard.ts`) :
 * elle garantit que les empreintes HMAC ne sont pas réversibles.
 */
export const TEST_RATE_LIMIT_SECRET =
  'secret-de-test-pour-la-limitation-0123456789'

/**
 * Boîte de notification des tests.
 *
 * Les parcours de devis et de contact refusent une demande si aucun destinataire
 * n'est configuré : sans valeur par défaut, chaque test de route devrait la
 * répéter, et un test pourrait « réussir » parce qu'il a oublié de le faire. Le
 * domaine `.test` est réservé (RFC 2606) : il ne peut désigner aucune boîte réelle.
 */
export const TEST_NOTIFICATION_EMAIL = 'notifications@m3design.test'

/** Environnement de Worker complet du point de vue du typing. */
export type TestEnvironment = Env & WorkerVariables

/** Charge non pertinente pour les routes d'API : aucun asset n'est servi. */
function stubAssets(): Fetcher {
  return {
    fetch: (): Promise<Response> =>
      Promise.resolve(new Response('asset absent', { status: 404 })),
  } as unknown as Fetcher
}

/**
 * Construit l'environnement d'un appel.
 *
 * Le secret de limitation et la boîte de notification sont fournis par défaut pour
 * que les tests qui ne parlent pas de configuration n'aient pas à les répéter ; les
 * surcharges permettent de les retirer (`RATE_LIMIT_SECRET: ''`,
 * `NOTIFICATION_EMAIL: ''`).
 */
export function createTestEnvironment(
  db: Db,
  overrides: Partial<TestEnvironment> = {},
): TestEnvironment {
  const base = {
    DB: db,
    ASSETS: stubAssets(),
    RATE_LIMIT_SECRET: TEST_RATE_LIMIT_SECRET,
    NOTIFICATION_EMAIL: TEST_NOTIFICATION_EMAIL,
  }
  return { ...base, ...overrides } as TestEnvironment
}

/** Horloge contrôlée par le test, en secondes Unix. */
export type TestClock = {
  now: () => number
  advance: (seconds: number) => void
}

/**
 * Crée une horloge figée puis avancée explicitement.
 *
 * Le temps est une entrée du système au même titre qu'une requête : sans horloge
 * contrôlée, un test de « délai de renvoi » dépendrait de la durée d'exécution de la
 * machine, donc serait instable.
 */
export function createTestClock(start: number): TestClock {
  let current = start
  return {
    now: () => current,
    advance: (seconds: number) => {
      current += seconds
    },
  }
}

/** Envoie un corps JSON à l'application, comme le ferait le front. */
export function postJson(
  app: Hono<AppEnv>,
  path: string,
  body: unknown,
  env: TestEnvironment,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      env,
    ),
  )
}

/** Envoie un corps brut, pour tester une entrée illisible. */
export function postRaw(
  app: Hono<AppEnv>,
  path: string,
  rawBody: string,
  env: TestEnvironment,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rawBody,
      },
      env,
    ),
  )
}

/** Corps d'une réponse, lu une seule fois puis mémorisé. */
const textCache = new WeakMap<Response, string>()

/** Corps analysé d'une réponse, mémorisé. */
const jsonCache = new WeakMap<Response, unknown>()

/**
 * Lit le corps texte d'une réponse, une seule fois.
 *
 * Un corps de `Response` n'est lisible qu'une fois : un test qui vérifie le code
 * d'erreur PUIS le message brut obtiendrait « Body is unusable » s'il lisait deux
 * fois. La mémorisation est la seule façon de garder des assertions indépendantes
 * les unes des autres.
 */
export async function readBodyText(response: Response): Promise<string> {
  const cached = textCache.get(response)
  if (cached !== undefined) {
    return cached
  }
  const text = await response.text()
  textCache.set(response, text)
  return text
}

/** Déplie le corps JSON d'une réponse, une seule fois également. */
export async function readJsonBody<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  const cached = jsonCache.get(response)
  if (cached !== undefined) {
    return cached as T
  }
  const parsed = JSON.parse(await readBodyText(response)) as T
  jsonCache.set(response, parsed)
  return parsed
}

/** Code d'erreur public d'une réponse d'échec (chaîne vide si la forme diffère). */
export async function readErrorCode(response: Response): Promise<string> {
  const body = await readJsonBody<{ error?: { code?: unknown } }>(response)
  return typeof body.error?.code === 'string' ? body.error.code : ''
}

/** Message public d'une réponse d'échec (chaîne vide si la forme diffère). */
export async function readErrorMessage(response: Response): Promise<string> {
  const body = await readJsonBody<{ error?: { message?: unknown } }>(response)
  return typeof body.error?.message === 'string' ? body.error.message : ''
}
