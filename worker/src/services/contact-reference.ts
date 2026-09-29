/**
 * Références publiques des messages de contact.
 *
 * La construction et la vérification sont communes à toutes les opérations :
 * voir `services/public-references.ts`. Ce module ne fixe que ce qui est propre au
 * contact — son préfixe `MSG` — exactement comme `quote-reference.ts` le fait pour
 * le devis.
 *
 * Pourquoi un préfixe distinct : la référence est la seule identité communiquée au
 * client, et elle est dictée au téléphone. `MSG-…` et `DEV-…` se distinguent à la
 * première lettre, donc un message de contact ne peut pas être confondu avec une
 * demande de devis, ni dans une conversation, ni dans une recherche de support.
 *
 * L'unicité est garantie par la base (`contact_messages.reference` est unique). En
 * cas de collision — événement improbable — l'insertion échoue avec le code
 * `contact_reference_conflict` : la couche service retente alors la génération
 * (quelques essais, puis erreur générique).
 */

import {
  PUBLIC_REFERENCE_RANDOM_LENGTH,
  generatePublicReference,
  isPublicReference,
} from './public-references'

/** Préfixe commun à toutes les références de message de contact. */
export const CONTACT_REFERENCE_PREFIX = 'MSG'

/** Nombre de caractères aléatoires : 32^8 combinaisons. */
export const CONTACT_REFERENCE_RANDOM_LENGTH = PUBLIC_REFERENCE_RANDOM_LENGTH

/**
 * Construit une référence de message pour une année donnée.
 *
 * `random` permet d'injecter une source déterministe dans les tests ; en
 * production, la source par défaut est `crypto.getRandomValues`.
 */
export function generateContactReference(options: {
  year: number
  random?: () => string
}): string {
  return generatePublicReference({
    prefix: CONTACT_REFERENCE_PREFIX,
    ...options,
  })
}

/** Vérifie qu'une chaîne respecte exactement le format public attendu. */
export function isContactReference(value: string): boolean {
  return isPublicReference(value, CONTACT_REFERENCE_PREFIX)
}
