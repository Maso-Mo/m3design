import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Compose une liste de classes, puis résout les conflits Tailwind.
 *
 * `clsx` gère les conditions (`false`, `undefined`, tableaux, objets), et
 * `tailwind-merge` fait gagner le DERNIER utilitaire de chaque famille : une
 * classe passée par l'appelant (`className`) surcharge donc réellement la
 * classe par défaut du composant, au lieu de cohabiter avec elle dans un ordre
 * imprévisible.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
