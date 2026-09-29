/**
 * Références publiques des opérations (demande de devis, message de contact).
 *
 * Une référence est la SEULE identité communiquée au client : l'identifiant interne
 * (`quote_requests.id`, `contact_messages.id`) ne sort jamais du serveur.
 * Conséquences, valables pour les deux opérations :
 *   * format lisible et dictable au téléphone, sans caractères ambigus (I/1, O/0),
 *     d'où l'alphabet à 32 caractères de `worker/src/lib/crypto.ts` ;
 *   * partie aléatoire de 8 caractères, soit 32^8 ≈ 1,1 × 10^12 combinaisons par
 *     année : deviner la référence d'un tiers est hors de portée ;
 *   * aucune donnée personnelle dans la référence : seulement l'année et le type
 *     d'opération.
 *
 * L'unicité est garantie par la base (colonne `reference` unique dans chaque
 * table). En cas de collision — événement improbable — l'insertion échoue avec le
 * code `quote_reference_conflict` ou `contact_reference_conflict`, et la couche
 * service retente la génération quelques fois avant d'abandonner proprement.
 *
 * Une seule implémentation pour les deux opérations : la seule différence est le
 * préfixe, qui doit rester une liste fermée (il entre dans un motif et dans une
 * contrainte de schéma).
 */

import { randomString } from '../lib/crypto'

/** Préfixes publics autorisés. Liste fermée, alignée sur les contraintes du schéma. */
export type PublicReferencePrefix = 'DEV' | 'MSG'

/** Vérifie qu'un préfixe reste une suite de lettres majuscules (donc sans motif). */
const PREFIX_PATTERN = /^[A-Z]{2,4}$/

/** Nombre de caractères aléatoires : 32^8 combinaisons. */
export const PUBLIC_REFERENCE_RANDOM_LENGTH = 8

/**
 * Construit une référence `<PRÉFIXE>-<ANNÉE>-<8 caractères>` pour une année donnée.
 *
 * `random` permet d'injecter une source déterministe dans les tests ; en
 * production, la source par défaut est `crypto.getRandomValues`.
 */
export function generatePublicReference(options: {
  prefix: PublicReferencePrefix
  year: number
  random?: () => string
}): string {
  const { prefix, year } = options
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new RangeError('le préfixe doit être une suite de lettres majuscules')
  }
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError("l'année doit être un entier à quatre chiffres")
  }
  const random =
    options.random ?? (() => randomString(PUBLIC_REFERENCE_RANDOM_LENGTH))
  return `${prefix}-${year}-${random()}`
}

/** Vérifie qu'une chaîne respecte exactement le format public d'un préfixe donné. */
export function isPublicReference(
  value: string,
  prefix: PublicReferencePrefix,
): boolean {
  if (!PREFIX_PATTERN.test(prefix)) {
    return false
  }
  // Le préfixe est validé ci-dessus : il ne peut injecter aucun métacaractère.
  return new RegExp(
    `^${prefix}-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{${PUBLIC_REFERENCE_RANDOM_LENGTH}}$`,
  ).test(value)
}
