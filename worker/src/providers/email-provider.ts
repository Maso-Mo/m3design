/**
 * Sélection du fournisseur d'envoi des notifications par courriel.
 *
 * Rôle de ce module : il n'envoie rien lui-même. Il décide QUEL fournisseur une
 * configuration donnée autorise, et refuse tout le reste. Les implémentations
 * réelles vivent dans `providers/resend.ts` (API HTTP) et
 * `providers/cloudflare-email.ts` (binding `send_email`) ; les tests injectent
 * leur propre fournisseur via le port `EmailProvider`, sans passer par ici.
 *
 * C'est un GARDE-FOU : aucun nom fictif n'est accepté, dans aucun environnement. Un
 * fournisseur « console » qui accepte tout sans rien envoyer donnerait l'illusion
 * que les demandes partent, alors que personne n'est prévenu — et c'est
 * exactement ce qu'une file de notifications ne doit jamais faire croire.
 *
 * Corollaire : la configuration est vérifiée une fois, à la construction. Une
 * valeur manquante ou mal formée échoue AVANT tout envoi, avec un code fermé ; le
 * message d'erreur ne recopie jamais la valeur fautive, car une clé collée de
 * travers ne doit pas finir dans un journal.
 */

import type { EmailProvider } from './messaging'
import {
  createCloudflareEmailProvider,
  type CloudflareEmailBindingSource,
} from './cloudflare-email'
import { createResendEmailProvider, readResendTimeoutMs } from './resend'

/**
 * Noms de fournisseurs fictifs refusés dans tous les environnements.
 *
 * Un fournisseur « console » ou « mock » accepterait tout sans rien envoyer : si un
 * jour la production était déployée avec cette valeur, les notifications
 * n'atteindraient personne, aucune erreur ne serait levée, et le service paraîtrait
 * fonctionner. Le refus est donc structurel plutôt que conditionné à un
 * environnement. Les tests injectent leur propre fournisseur.
 */
export const REFUSED_FAKE_PROVIDERS: readonly string[] = [
  'console',
  'fake',
  'faux',
  'mock',
  'stub',
  'memory',
  'inmemory',
  'test',
  'tests',
  'local',
  'dev',
  'development',
]

/** Codes d'erreur de sélection. Liste fermée, aucune valeur recopiée. */
export type EmailProviderErrorCode =
  | 'email_provider_missing'
  | 'email_provider_unknown'
  | 'email_provider_fake_refused'
  | 'email_provider_invalid'
  | 'email_api_key_missing'
  | 'email_api_key_invalid'
  | 'email_binding_missing'
  | 'email_from_missing'
  | 'email_from_invalid'
  | 'email_timeout_invalid'

const PROVIDER_MESSAGES: Record<EmailProviderErrorCode, string> = {
  email_provider_missing:
    "Aucun fournisseur d'envoi de courriel n'est configuré (EMAIL_PROVIDER).",
  email_provider_unknown:
    "Le fournisseur d'envoi de courriel configuré n'est pas reconnu (EMAIL_PROVIDER).",
  email_provider_fake_refused:
    "Un fournisseur d'envoi fictif ne peut pas être utilisé : il est réservé aux tests, qui l'injectent explicitement.",
  email_provider_invalid:
    "La configuration du fournisseur d'envoi de courriel est refusée : une valeur est mal formée.",
  email_api_key_missing:
    "Le fournisseur d'envoi de courriel est déclaré mais sa clé d'API manque (RESEND_API_KEY).",
  email_api_key_invalid:
    "La clé d'API du fournisseur d'envoi de courriel est mal formée (RESEND_API_KEY).",
  email_binding_missing:
    "Le fournisseur d'envoi de courriel choisi exige le binding EMAIL, absent de wrangler.jsonc.",
  email_from_missing:
    "L'adresse d'expédition des notifications n'est pas configurée (EMAIL_FROM_ADDRESS).",
  email_from_invalid:
    "L'adresse d'expédition des notifications est mal formée (EMAIL_FROM_ADDRESS).",
  email_timeout_invalid:
    "Le délai maximal d'envoi est mal formé (EMAIL_TIMEOUT_MS).",
}

/**
 * Erreur de configuration de l'envoi des notifications.
 *
 * Le message est construit à partir de constantes et, au plus, du NOM de la
 * variable en cause : jamais de sa valeur.
 */
export class EmailConfigurationError extends Error {
  readonly code: EmailProviderErrorCode
  /** Nom de la variable fautive, quand un seul nom suffit à corriger. */
  readonly field?: string

  constructor(code: EmailProviderErrorCode, field?: string) {
    super(
      field === undefined
        ? PROVIDER_MESSAGES[code]
        : `${PROVIDER_MESSAGES[code]} (${field})`,
    )
    this.name = 'EmailConfigurationError'
    this.code = code
    this.field = field
  }
}

/** Fournisseurs réels acceptés. Deux voies, un seul port de sortie. */
export const RESEND_PROVIDER = 'resend'
export const CLOUDFLARE_EMAIL_PROVIDER = 'cloudflare'

/**
 * Noms fictifs refusés dans tous les environnements.
 *
 * Elle couvre les noms qu'un développeur pourrait inventer pour un double de test
 * resté branché (console, mock, « juste en local »), y compris les serveurs SMTP de
 * développement.
 */
export const REFUSED_FAKE_EMAIL_PROVIDERS: readonly string[] = [
  ...REFUSED_FAKE_PROVIDERS,
  'mailhog',
  'mailpit',
  'smtp',
  'log',
]

/**
 * Variables d'environnement lues par ce module.
 *
 * Les valeurs sont optionnelles : c'est la fonction de sélection qui décide, cas
 * par cas, ce qui est requis. Les noms sont documentés dans `.dev.vars.example`.
 */
export type EmailProviderEnvironmentSource = {
  /** `resend` ou `cloudflare`. Aucune valeur par défaut. */
  EMAIL_PROVIDER?: string
  /** Adresse d'expédition, sur un domaine autorisé par le fournisseur. */
  EMAIL_FROM_ADDRESS?: string
  /** Nom affiché, facultatif. */
  EMAIL_FROM_NAME?: string
  /** Délai maximal d'un appel HTTP, en millisecondes (1000 à 30000). */
  EMAIL_TIMEOUT_MS?: string
  /** Clé d'API Resend (secrète). */
  RESEND_API_KEY?: string
} & CloudflareEmailBindingSource

/** Fournisseur prêt à l'emploi, avec l'adresse d'expédition validée. */
export type EmailSender = {
  provider: EmailProvider
  /** Adresse d'expédition, en minuscules. */
  from: string
  /** Nom affiché, quand il est configuré. */
  fromName?: string
}

/**
 * Motif de l'adresse d'expédition.
 *
 * Même exigence que pour le destinataire (`ck_email_outbox_recipient`) : une seule
 * arobase, un domaine et une extension. Une adresse refusée par le fournisseur
 * coûterait un envoi et un nouvel essai ; autant la refuser avant d'écrire quoi que
 * ce soit dans la file.
 */
const FROM_ADDRESS_PATTERN = /^[^@\s<>]+@[^@\s<>]+\.[^\s<>]{2,}$/

/** Nom affiché : jamais de chevrons, de guillemets ni de retour à la ligne. */
const FROM_NAME_PATTERN = /^[^<>"\r\n]{1,80}$/

/** Options d'injection réservées aux tests. */
export type ReadEmailSenderOptions = {
  fetchImplementation?: typeof fetch
}

/**
 * Traduit l'échec d'une fabrique en erreur de configuration fermée.
 *
 * Les fabriques signalent une valeur mal formée par un `RangeError` dont le
 * message est un code interne connu (jamais la valeur) : c'est ce code qui est
 * traduit ici, pour que l'appelant n'ait qu'un seul type d'erreur à traiter.
 */
function configurationErrorFromFactory(
  error: unknown,
): EmailConfigurationError {
  const code = error instanceof RangeError ? error.message : ''
  if (code === 'resend_api_key_invalid') {
    return new EmailConfigurationError(
      'email_api_key_invalid',
      'RESEND_API_KEY',
    )
  }
  if (code === 'resend_timeout_invalid') {
    return new EmailConfigurationError(
      'email_timeout_invalid',
      'EMAIL_TIMEOUT_MS',
    )
  }
  return new EmailConfigurationError('email_provider_invalid', 'EMAIL_PROVIDER')
}

/** Lit et valide l'adresse d'expédition, en minuscules. */
function readFromAddress(source: EmailProviderEnvironmentSource): string {
  const raw = (source.EMAIL_FROM_ADDRESS ?? '').trim()
  if (raw === '') {
    throw new EmailConfigurationError(
      'email_from_missing',
      'EMAIL_FROM_ADDRESS',
    )
  }
  const from = raw.toLowerCase()
  if (from !== raw || !FROM_ADDRESS_PATTERN.test(from)) {
    throw new EmailConfigurationError(
      'email_from_invalid',
      'EMAIL_FROM_ADDRESS',
    )
  }
  return from
}

/** Lit le nom affiché, facultatif, sans jamais recopier sa valeur. */
function readFromName(
  source: EmailProviderEnvironmentSource,
): string | undefined {
  const raw = (source.EMAIL_FROM_NAME ?? '').trim()
  if (raw === '') {
    return undefined
  }
  if (!FROM_NAME_PATTERN.test(raw)) {
    throw new EmailConfigurationError('email_from_invalid', 'EMAIL_FROM_NAME')
  }
  return raw
}

/**
 * Lit l'environnement et construit le fournisseur d'envoi.
 *
 * L'ordre des contrôles est celui dans lequel un humain corrige : nom du
 * fournisseur, puis autorisation (clé ou binding), puis adresse d'expédition. Une
 * erreur désigne donc toujours la PREMIÈRE chose à corriger.
 */
export function readEmailSender(
  source: EmailProviderEnvironmentSource = {},
  options: ReadEmailSenderOptions = {},
): EmailSender {
  const name = (source.EMAIL_PROVIDER ?? '').trim().toLowerCase()
  if (name === '') {
    throw new EmailConfigurationError(
      'email_provider_missing',
      'EMAIL_PROVIDER',
    )
  }
  if (REFUSED_FAKE_EMAIL_PROVIDERS.includes(name)) {
    throw new EmailConfigurationError(
      'email_provider_fake_refused',
      'EMAIL_PROVIDER',
    )
  }
  if (name !== RESEND_PROVIDER && name !== CLOUDFLARE_EMAIL_PROVIDER) {
    throw new EmailConfigurationError(
      'email_provider_unknown',
      'EMAIL_PROVIDER',
    )
  }

  const from = readFromAddress(source)
  const fromName = readFromName(source)

  if (name === RESEND_PROVIDER) {
    const apiKey = (source.RESEND_API_KEY ?? '').trim()
    if (apiKey === '') {
      throw new EmailConfigurationError(
        'email_api_key_missing',
        'RESEND_API_KEY',
      )
    }
    let timeoutMs: number | undefined
    try {
      timeoutMs = readResendTimeoutMs(source.EMAIL_TIMEOUT_MS)
    } catch (error) {
      throw configurationErrorFromFactory(error)
    }
    try {
      return {
        from,
        ...(fromName === undefined ? {} : { fromName }),
        provider: createResendEmailProvider({
          apiKey,
          // Le format « Nom <adresse> » est celui attendu par l'API Resend.
          from: fromName === undefined ? from : `${fromName} <${from}>`,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(options.fetchImplementation === undefined
            ? {}
            : { fetchImplementation: options.fetchImplementation }),
        }),
      }
    } catch (error) {
      throw configurationErrorFromFactory(error)
    }
  }

  const binding = source.EMAIL
  if (binding === undefined) {
    throw new EmailConfigurationError('email_binding_missing', 'EMAIL')
  }
  return {
    from,
    ...(fromName === undefined ? {} : { fromName }),
    provider: createCloudflareEmailProvider({
      binding,
      from,
      ...(fromName === undefined ? {} : { fromName }),
    }),
  }
}
