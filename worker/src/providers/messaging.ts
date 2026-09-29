/**
 * Ports de sortie vers le fournisseur de courriel des notifications.
 *
 * Ces interfaces sont volontairement déclarées SANS implémentation : le fournisseur
 * réel (Resend, ou le binding d'Email Routing) se branche sans modifier ni le schéma,
 * ni les dépôts, ni les services. Le côté persistance existe déjà : la file
 * `email_outbox` (voir `worker/src/db/repositories/email-outbox.ts`).
 *
 * Règles pour toute implémentation future :
 *   * les secrets (jeton d'API, identifiants) viennent de l'environnement du
 *     Worker (`.dev.vars` en local, `wrangler secret put` en ligne), jamais du
 *     dépôt ;
 *   * un échec d'envoi est renvoyé comme résultat (`accepted: false`), avec un code
 *     technique court, jamais par une exception
 *     contenant la réponse brute du fournisseur : celle-ci peut recopier le numéro
 *     de téléphone, l'adresse du destinataire ou le contenu du message ;
 *   * l'implémentation n'écrit aucun journal contenant un numéro, un code, une
 *     adresse ou un contenu : c'est la couche service qui décide de ce qui est
 *     journalisé (référence publique, code d'erreur, jamais de donnée
 *     personnelle) ;
 *   * l'envoi est piloté par la couche service, qui marque ensuite l'entrée de la
 *     file d'attente comme envoyée ou en échec.
 */

/**
 * Codes d'échec d'envoi de courriel.
 *
 * Liste fermée : elle sert au diagnostic et au support, jamais à raconter la
 * réponse du fournisseur à qui que ce soit. Tous respectent la forme attendue par
 * la couche service (minuscules, chiffres et soulignés, 32 caractères au plus), de
 * sorte qu'aucun message brut ne puisse se faire passer pour un code technique.
 */
export type EmailSendFailureCode =
  | 'invalid_recipient'
  | 'sender_not_verified'
  | 'recipient_undeliverable'
  | 'auth_failed'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'endpoint_not_found'
  | 'request_rejected'
  | 'unexpected_response'
  | 'network_error'
  | 'timeout'

/** Courriel à remettre à un fournisseur. */
export type OutboundEmail = {
  to: string
  subject: string
  bodyText: string
}

/**
 * Résultat d'un envoi de courriel, sans donnée personnelle.
 *
 * `accepted: true` signifie que le fournisseur a ACCEPTÉ le message et a renvoyé un
 * identifiant — rien de plus. Ce n'est ni une remise au destinataire, ni a fortiori
 * une lecture : un message accepté peut être rejeté plus tard (adresse invalide,
 * quota, filtre anti-pourriel), et le fournisseur ne le signalerait que par ses
 * propres notifications de remise, canal qui n'est pas mis en place ici.
 *
 * Le vocabulaire employé partout dans le projet reste donc « accepté pour
 * distribution », jamais « reçu par le client ». La seule preuve de réception est
 * l'accusé affiché dans la boîte du destinataire — hors de portée du serveur, et
 * c'est au test manuel de la constater.
 */
export type EmailSendResult = {
  accepted: boolean
  /** Identifiant technique du fournisseur, utile au support. */
  providerMessageId?: string
  /** Code technique court en cas d'échec (jamais le message du fournisseur). */
  errorCode?: string
  /** Délai conseillé avant un nouvel essai, en secondes. */
  retryAfterSeconds?: number
}

/** Port d'envoi de courriels. */
export interface EmailProvider {
  send(email: OutboundEmail): Promise<EmailSendResult>
}
