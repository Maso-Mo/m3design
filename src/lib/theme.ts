/**
 * Thème clair / sombre — la logique, hors React.
 *
 * Source de vérité : l'attribut `data-theme` de `<html>`, posé AVANT le premier
 * rendu par le script en ligne de `index.html` (c'est lui qui supprime tout
 * flash de thème au chargement). Ce module se contente de lire cet attribut, de
 * le modifier et de prévenir les abonnés : le thème affiché et le thème connu
 * des composants ne peuvent donc pas diverger.
 */

export type Theme = 'light' | 'dark'

/**
 * Clé de mémorisation du choix explicite du visiteur. Elle est lue par le
 * script de `index.html` : toute modification doit être faite des deux côtés.
 */
export const THEME_STORAGE_KEY = 'm3design-theme'

const listeners = new Set<() => void>()

/** Thème déclaré par le système d'exploitation. */
export function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/** Choix mémorisé du visiteur, ou `null` s'il n'a jamais choisi. */
export function getStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : null
  } catch {
    // Stockage refusé (navigation privée, cookies bloqués) : on l'ignore, le
    // thème système prendra le relais.
    return null
  }
}

/** Thème réellement appliqué au document, tel que le voit le visiteur. */
export function getAppliedTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** Applique un thème au document, sans le mémoriser. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.theme = theme
}

/**
 * Applique un thème ET le mémorise comme choix explicite, puis prévient les
 * abonnés. C'est l'unique porte d'entrée utilisée par le sélecteur de thème.
 */
export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Le thème s'applique quand même pour la visite en cours.
  }
  applyTheme(theme)
  notifyThemeChange()
}

export function toggleTheme(): void {
  setTheme(getAppliedTheme() === 'dark' ? 'light' : 'dark')
}

/**
 * Abonnement utilisé par React (`useSyncExternalStore`) : les abonnés sont
 * prévenus dès qu'un thème est appliqué par ce module.
 */
export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Signale un changement de thème appliqué hors de `setTheme` (ex. système). */
export function notifyThemeChange(): void {
  for (const listener of listeners) {
    listener()
  }
}
