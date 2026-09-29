/**
 * Références publiques des demandes de devis.
 *
 * La construction et la vérification sont communes à toutes les opérations :
 * voir `services/public-references.ts`. Ce module ne fixe que ce qui est propre au
 * devis — son préfixe `DEV` — et conserve les noms historiques utilisés par le
 * service et les tests.
 *
 * L'unicité est garantie par la base (`quote_requests.reference` est unique). En
 * cas de collision — événement improbable — l'insertion échoue avec le code
 * `quote_reference_conflict` : la couche service devra alors retenter la
 * génération (quelques essais, puis erreur générique).
 */

import {
  PUBLIC_REFERENCE_RANDOM_LENGTH,
  generatePublicReference,
  isPublicReference,
} from './public-references'

/** Préfixe commun à toutes les références de demande de devis. */
export const QUOTE_REFERENCE_PREFIX = 'DEV'

/** Nombre de caractères aléatoires : 32^8 combinaisons. */
export const QUOTE_REFERENCE_RANDOM_LENGTH = PUBLIC_REFERENCE_RANDOM_LENGTH

/**
 * Construit une référence de demande pour une année donnée.
 *
 * `random` permet d'injecter une source déterministe dans les tests ; en
 * production, la source par défaut est `crypto.getRandomValues`.
 */
export function generateQuoteReference(options: {
  year: number
  random?: () => string
}): string {
  return generatePublicReference({
    prefix: QUOTE_REFERENCE_PREFIX,
    ...options,
  })
}

/** Vérifie qu'une chaîne respecte exactement le format public attendu. */
export function isQuoteReference(value: string): boolean {
  return isPublicReference(value, QUOTE_REFERENCE_PREFIX)
}
