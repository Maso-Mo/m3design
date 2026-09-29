/**
 * Envoi des notifications par le binding `send_email` (Cloudflare Email Routing).
 *
 * Pourquoi cette voie, en complément de `providers/resend.ts` : elle ne demande
 * AUCUN compte chez un tiers et ne coûte rien — l'envoi sort par l'infrastructure
 * de Cloudflare, sur un domaine dont Email Routing est activé. En contrepartie
 * elle impose trois conditions, toutes côté compte Cloudflare :
 *
 *   1. un domaine géré par Cloudflare, avec Email Routing ACTIF ;
 *   2. une adresse d'expédition sur ce domaine (une seule fois, dans « Email
 *      Routing > Email Addresses ») ;
 *   3. un destinataire VÉRIFIÉ dans le compte : le binding ne peut écrire qu'aux
 *      adresses de destination confirmées. C'est ce qui rend cette voie pratique
 *      pour nos tests — la boîte de développement est vérifiée une fois, et rien
 *      ne peut fuiter vers une adresse inconnue.
 *
 * Le binding n'est utilisé que si `EMAIL_PROVIDER=cloudflare` ET si le binding
 * `EMAIL` est déclaré dans `wrangler.jsonc`. Sans lui, la sélection échoue avec un
 * code fermé (`email_binding_missing`) : jamais un envoi silencieusement perdu.
 *
 * Règles identiques aux autres fournisseurs : aucun secret ici (le binding porte
 * l'autorisation), la réponse du binding n'est jamais recopiée, un échec est un
 * RÉSULTAT, et un message n'est compté comme accepté que si un identifiant est
 * renvoyé.
 */

import type {
  EmailProvider,
  EmailSendFailureCode,
  EmailSendResult,
  OutboundEmail,
} from './messaging'

/**
 * Source du binding, telle que lue depuis l'environnement du Worker.
 *
 * Le type est structurel et la propriété est optionnelle : le code compile et
 * fonctionne que le binding soit déclaré ou non dans `wrangler.jsonc`. C'est la
 * sélection (`providers/email-provider.ts`) qui refuse l'absence de binding, avec
 * un message utile, plutôt qu'une erreur de type à la compilation.
 */
export type CloudflareEmailBindingSource = {
  EMAIL?: SendEmail
}

/** Configuration du fournisseur, déjà extraite par la sélection. */
export type CloudflareEmailProviderConfig = {
  binding: SendEmail
  /** Adresse d'expédition, sur le domaine dont Email Routing est actif. */
  from: string
  /** Nom affiché, facultatif. */
  fromName?: string
}

/**
 * Codes d'erreur du binding regroupés par cause.
 *
 * Les identifiants sont ceux d'Email Routing (`E_…`). Le regroupement est
 * volontairement large : plusieurs codes distincts ont la même conséquence pour
 * nous, et un code inconnu devient `request_rejected` — la cause la plus prudente,
 * qui n'accuse ni le destinataire ni notre configuration.
 */
const SENDER_ERROR_CODES: readonly string[] = [
  'E_SENDER_NOT_VERIFIED',
  'E_SENDER_NOT_ALLOWED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_DOMAIN_NOT_AVAILABLE',
]
const RECIPIENT_ERROR_CODES: readonly string[] = [
  'E_RECIPIENT_NOT_VERIFIED',
  'E_RECIPIENT_SUPPRESSED',
]
const INVALID_RECIPIENT_ERROR_CODES: readonly string[] = [
  'E_TOO_MANY_RECIPIENTS',
  'E_INVALID_RECIPIENT',
]
const RATE_LIMIT_ERROR_CODES: readonly string[] = [
  'E_RATE_LIMITED',
  'E_TOO_MANY_REQUESTS',
]
const PROVIDER_ERROR_CODES: readonly string[] = [
  'E_INTERNAL_ERROR',
  'E_UNAVAILABLE',
]

/** Forme d'un code technique du binding, telle qu'attendue dans un journal. */
const BINDING_CODE_PATTERN = /^E_[A-Z0-9_]{2,48}$/

/** Identifiant de message : caractères techniques, longueur bornée. */
const PROVIDER_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:=+/-]{1,200}$/

/**
 * Lit le code technique d'une erreur du binding, sans rien recopier d'autre.
 *
 * Le binding lève une erreur dont le `code` porte un identifiant `E_…`. Seuls ces
 * identifiants sont lus ; le reste du message — qui peut contenir l'adresse du
 * destinataire — n'est jamais conservé.
 */
function readBindingCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') {
    const trimmed = code.trim().toUpperCase()
    if (BINDING_CODE_PATTERN.test(trimmed)) {
      return trimmed
    }
  }
  return null
}

/** Traduit un code du binding en code d'échec interne. */
export function failureCodeFromBindingError(
  error: unknown,
): EmailSendFailureCode {
  const code = readBindingCode(error)
  if (code === null) {
    // Ni code technique lisible ni forme connue : panne, et non refus de contenu.
    return 'provider_unavailable'
  }
  if (SENDER_ERROR_CODES.includes(code)) {
    return 'sender_not_verified'
  }
  if (RECIPIENT_ERROR_CODES.includes(code)) {
    return 'recipient_undeliverable'
  }
  if (INVALID_RECIPIENT_ERROR_CODES.includes(code)) {
    return 'invalid_recipient'
  }
  if (RATE_LIMIT_ERROR_CODES.includes(code)) {
    return 'rate_limited'
  }
  if (PROVIDER_ERROR_CODES.includes(code)) {
    return 'provider_unavailable'
  }
  return 'request_rejected'
}

/**
 * Construit le fournisseur à partir du binding déclaré dans `wrangler.jsonc`.
 *
 * Aucune vérification de configuration n'est faite ici : l'adresse d'expédition et
 * la présence du binding sont validées une seule fois, par la sélection
 * (`readEmailSender`), pour que les deux fournisseurs partagent les mêmes règles.
 */
export function createCloudflareEmailProvider(
  config: CloudflareEmailProviderConfig,
): EmailProvider {
  const fromName = config.fromName?.trim()

  return {
    async send(email: OutboundEmail): Promise<EmailSendResult> {
      try {
        const sent = await config.binding.send({
          from:
            fromName === undefined
              ? config.from
              : { name: fromName, email: config.from },
          to: email.to,
          subject: email.subject,
          // Texte brut uniquement : le corps vient de `services/notifications.ts`.
          text: email.bodyText,
        })

        const providerMessageId = sent?.messageId?.trim() ?? ''
        if (!PROVIDER_MESSAGE_ID_PATTERN.test(providerMessageId)) {
          return { accepted: false, errorCode: 'unexpected_response' }
        }
        return { accepted: true, providerMessageId }
      } catch (error) {
        // Le message de l'erreur n'est jamais recopié : seul son code technique,
        // quand il en a un, est traduit en code fermé.
        return {
          accepted: false,
          errorCode: failureCodeFromBindingError(error),
        }
      }
    },
  }
}
