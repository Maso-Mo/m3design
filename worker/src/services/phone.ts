/**
 * Normalisation et masquage des numéros de téléphone.
 *
 * La normalisation est indispensable avant toute comparaison : « 034 12 345 67 »,
 * « +261 34 12 345 67 » et « 00261341234567 » désignent le même abonné. Sans
 * normalisation, l'unicité « une demande active par numéro » serait contournable
 * en changeant la mise en forme, et les tentatives de vérification ne seraient
 * plus comptabilisées ensemble.
 *
 * Choix assumé de cette étape : un format international explicite est EXIGÉ (le
 * numéro doit commencer par « + » ou « 00 »). Aucun pays n'est deviné par défaut :
 * deviner un indicatif à partir d'un numéro local produirait des numéros faux et
 * silencieusement acceptés. Le formulaire public accompagnera la saisie d'un
 * sélecteur de pays à l'étape suivante.
 *
 * Ce module ne fait AUCUNE requête réseau et ne s'appuie sur aucune bibliothèque :
 * la règle appliquée est celle de l'E.164 (indicatif pays, 8 à 15 chiffres).
 */

/** Motifs d'échec de normalisation, destinés à la couche service. */
export type PhoneNormalizationFailure =
  'empty' | 'invalid_characters' | 'missing_country_code' | 'invalid_length'

export type PhoneNormalizationResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: PhoneNormalizationFailure }

/** Longueur maximale d'un numéro E.164, indicatif pays compris. */
const MAX_DIGITS = 15

/** Longueur minimale acceptée (indicatif pays + numéro national court). */
const MIN_DIGITS = 8

/** Longueur maximale d'une saisie brute, avant nettoyage. */
const MAX_RAW_LENGTH = 32

/**
 * Normalise un numéro saisi par un utilisateur.
 *
 * Étapes : nettoyage des séparateurs usuels (espaces insécables compris),
 * conversion du préfixe international « 00 » en « + », refus de tout autre
 * caractère, contrôle de l'indicatif pays puis de la longueur.
 */
export function normalizePhoneNumber(raw: string): PhoneNormalizationResult {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > MAX_RAW_LENGTH) {
    return { ok: false, reason: 'empty' }
  }

  // Séparateurs de saisie tolérés : espaces (dont insécables et fines), points,
  // tirets, parenthèses et barres obliques.
  let cleaned = trimmed.replace(/[\s\u00A0\u202F.\-()/]/g, '')

  if (cleaned.startsWith('00')) {
    cleaned = `+${cleaned.slice(2)}`
  }

  if (!/^\+?[0-9]+$/.test(cleaned)) {
    return { ok: false, reason: 'invalid_characters' }
  }

  if (!cleaned.startsWith('+')) {
    return { ok: false, reason: 'missing_country_code' }
  }

  const digits = cleaned.slice(1)
  // Un indicatif pays E.164 ne commence jamais par 0.
  if (digits.startsWith('0')) {
    return { ok: false, reason: 'missing_country_code' }
  }
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    return { ok: false, reason: 'invalid_length' }
  }

  return { ok: true, normalized: `+${digits}` }
}

/**
 * Version masquée d'un numéro, pour les journaux d'exploitation.
 *
 * Les journaux ne doivent jamais contenir de numéro complet : un numéro est une
 * donnée personnelle. Le masque conserve de quoi identifier une ligne de journal
 * (« est-ce le même appelant ? ») sans permettre de rappeler l'abonné.
 */
export function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '')
  if (digits.length <= 6) {
    return '•'.repeat(digits.length || 3)
  }
  const prefix = digits.slice(0, 4)
  const suffix = digits.slice(-2)
  return `+${prefix}${'•'.repeat(digits.length - 6)}${suffix}`
}
