/**
 * Notifications internes de M3Design : « une demande vient d'être reçue ».
 *
 * Principe : la notification n'est pas un effet secondaire de l'affichage, c'est une
 * PARTIE de l'acceptation d'une demande. Un devis ou un message reçu dont personne
 * n'est prévenu est un message perdu ; la couche service refuse donc une demande
 * lorsqu'aucune boîte de notification n'est configurée, plutôt que d'enregistrer
 * une donnée que personne ne verra (voir `services/quote-request.ts` et
 * `services/contact-request.ts`).
 *
 * Ce module est PUR : il lit une variable d'environnement et compose du texte. Il
 * n'écrit rien, n'envoie rien et ne connaît aucun fournisseur. L'envoi appartient à
 * la file `email_outbox` (`db/repositories/email-outbox.ts`), ce qui rend
 * l'enregistrement de la demande et sa notification solidaires : les deux lignes
 * sont écrites dans le même lot, donc en tout ou rien.
 *
 * Deux règles de rédaction, valables pour les deux opérations :
 *   * le sujet et le corps sont du TEXTE BRUT, jamais du HTML : pas de contenu
 *     actif, pas de suivi d'ouverture, et un courriel lisible dans n'importe quel
 *     client ;
 *   * le corps ne contient QUE les données nécessaires au traitement — référence,
 *     horodatage, numéro vérifié, coordonnées et texte du besoin. Aucune preuve de
 *     vérification, aucun identifiant technique de challenge n'y figure : ces
 *     valeurs n'ont aucune utilité pour le destinataire et n'ont rien à faire dans
 *     une boîte aux lettres.
 *
 * Choix de la boîte de destination : `NOTIFICATION_EMAIL`. Elle est lue ici, une
 * fois, et validée selon les mêmes règles que la contrainte
 * `ck_email_outbox_recipient` du schéma : une adresse légèrement mal saisie est
 * signalée comme erreur de configuration au démarrage plutôt que de faire échouer
 * silencieusement chaque demande au moment de l'insertion.
 */

/** Source d'environnement lue par ce module. Le type est structurel. */
export type NotificationEnvironmentSource = {
  /** Boîte qui reçoit les demandes (M3Design). Aucune valeur par défaut. */
  NOTIFICATION_EMAIL?: string
}

/** Codes d'erreur de configuration. Liste fermée, aucune valeur recopiée. */
export type NotificationConfigurationErrorCode =
  'notification_email_missing' | 'notification_email_invalid'

/** Messages fixes : le nom de la variable est ajouté, jamais sa valeur. */
const CONFIGURATION_MESSAGES: Record<
  NotificationConfigurationErrorCode,
  string
> = {
  notification_email_missing:
    "La boîte de notification des demandes n'est pas configurée : NOTIFICATION_EMAIL est requis.",
  notification_email_invalid:
    'La boîte de notification des demandes est mal formée : NOTIFICATION_EMAIL doit être une adresse électronique en minuscules.',
}

/**
 * Erreur de configuration des notifications.
 *
 * Le message est construit uniquement à partir de constantes : l'adresse fautive
 * n'y est jamais recopiée, car un message d'erreur se retrouve dans les journaux.
 */
export class NotificationConfigurationError extends Error {
  readonly code: NotificationConfigurationErrorCode
  /** Nom de la variable fautive (jamais sa valeur). */
  readonly field: string

  constructor(code: NotificationConfigurationErrorCode) {
    super(`${CONFIGURATION_MESSAGES[code]} (NOTIFICATION_EMAIL)`)
    this.name = 'NotificationConfigurationError'
    this.code = code
    this.field = 'NOTIFICATION_EMAIL'
  }
}

/**
 * Mêmes règles que `ck_email_outbox_recipient` : minuscules, longueur 6 à 254,
 * une partie locale, un domaine et une extension. Une adresse refusée ici serait
 * refusée par la base de toute façon — autant le dire avant d'avoir consommé la
 * preuve de vérification du client.
 */
const RECIPIENT_PATTERN = /^[^@\s]+@[^@\s]+\.[^\s@]{2,}$/

/** Lit, valide et renvoie la boîte de notification configurée. */
export function readNotificationRecipient(
  source: NotificationEnvironmentSource = {},
): string {
  const raw = (source.NOTIFICATION_EMAIL ?? '').trim()
  if (raw === '') {
    throw new NotificationConfigurationError('notification_email_missing')
  }
  const recipient = raw.toLowerCase()
  if (
    recipient !== raw ||
    recipient.length < 6 ||
    recipient.length > 254 ||
    !RECIPIENT_PATTERN.test(recipient)
  ) {
    throw new NotificationConfigurationError('notification_email_invalid')
  }
  return recipient
}

/** Notification prête à être mise en file : destinataire, sujet, corps texte. */
export type RequestNotificationDraft = {
  recipient: string
  subject: string
  bodyText: string
}

/**
 * Horodatage lisible et SANS ambiguïté de fuseau : les demandes arrivent de tous
 * les fuseaux, et une date locale non étiquetée serait interprétée de travers par
 * le destinataire. Le format est fixe, donc comparable d'un courriel à l'autre.
 */
function formatUtcTimestamp(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Champs communs aux deux types de notification. */
type NotificationFields = {
  recipient: string
  reference: string
  contactName: string
  contactEmail: string
}

/**
 * Coordonnées du demandeur : mêmes lignes pour un devis et pour un message.
 *
 * Le nom et l'adresse électronique sont obligatoires (le formulaire les exige), et
 * le téléphone, FACULTATIF, est présenté pour ce qu'il est : un moyen de rappeler le
 * client, jamais une preuve d'identité. Aucune mention de vérification n'apparaît
 * donc dans un courriel — cette notion n'existe plus dans la V1.
 */
function contactLines(
  fields: NotificationFields,
  phoneNormalized: string | null,
): string[] {
  return [
    `Nom : ${fields.contactName}`,
    `Adresse électronique : ${fields.contactEmail}`,
    `Téléphone : ${phoneNormalized ?? '(non renseigné)'}`,
  ]
}

/**
 * Rédige la notification d'une demande de devis.
 *
 * Longueur maximale du corps, par construction : la description est bornée à 2000
 * caractères et les autres champs à quelques dizaines ou centaines, donc le corps
 * reste très en deçà des 20000 caractères exigés par `ck_email_outbox_body`. Un
 * dépassement ne pourrait venir que d'une donnée écrite par le serveur lui-même, et
 * il échouerait alors visiblement (transaction annulée) au lieu de tronquer en
 * silence le besoin d'un client.
 */
export function buildQuoteNotification(input: {
  recipient: string
  reference: string
  receivedAt: number
  description: string
  contactName: string
  contactEmail: string
  phoneNormalized: string | null
}): RequestNotificationDraft {
  const bodyText = [
    'Nouvelle demande de devis reçue sur le site M3Design.',
    '',
    `Référence : ${input.reference}`,
    `Reçue le : ${formatUtcTimestamp(input.receivedAt)}`,
    ...contactLines(input, input.phoneNormalized),
    '',
    'Description du besoin :',
    input.description,
  ].join('\n')

  return {
    recipient: input.recipient,
    // Le sujet porte la référence : c'est elle qui permet de retrouver la demande
    // dans une boîte encombrée, sans ouvrir le courriel.
    subject: `Nouvelle demande de devis ${input.reference}`,
    bodyText,
  }
}

/** Rédige la notification d'un message de contact (mêmes règles que le devis). */
export function buildContactNotification(input: {
  recipient: string
  reference: string
  receivedAt: number
  message: string
  contactName: string
  contactEmail: string
  phoneNormalized: string | null
}): RequestNotificationDraft {
  const bodyText = [
    'Nouveau message de contact reçu sur le site M3Design.',
    '',
    `Référence : ${input.reference}`,
    `Reçu le : ${formatUtcTimestamp(input.receivedAt)}`,
    ...contactLines(input, input.phoneNormalized),
    '',
    'Message :',
    input.message,
  ].join('\n')

  return {
    recipient: input.recipient,
    subject: `Nouveau message de contact ${input.reference}`,
    bodyText,
  }
}
