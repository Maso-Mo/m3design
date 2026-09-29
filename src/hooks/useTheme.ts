import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  applyTheme,
  getAppliedTheme,
  getStoredTheme,
  getSystemTheme,
  setTheme as persistTheme,
  subscribeToTheme,
  toggleTheme as flipTheme,
  type Theme,
} from '../lib/theme'

export interface UseThemeResult {
  /** Thème actuellement appliqué : celui que voit le visiteur. */
  readonly theme: Theme
  /** Choisit un thème et le mémorise pour les visites suivantes. */
  readonly setTheme: (theme: Theme) => void
  /** Bascule entre clair et sombre. */
  readonly toggleTheme: () => void
}

/**
 * Thème clair / sombre du document, partagé par tous les composants.
 *
 * Le document est la source de vérité (`data-theme`), et non un état React :
 * `useSyncExternalStore` garantit que tous les composants qui appellent ce hook
 * affichent la même chose, sans contexte React ni rendu en cascade au
 * chargement. Le script de `index.html` ayant déjà posé l'attribut, le premier
 * rendu est correct : aucun flash.
 */
export function useTheme(): UseThemeResult {
  const theme = useSyncExternalStore(subscribeToTheme, getAppliedTheme)

  useEffect(() => {
    // Tant que le visiteur n'a pas choisi explicitement, on suit les
    // changements du système (bascule automatique du soir, par exemple).
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (getStoredTheme() !== null) {
        return
      }
      applyTheme(getSystemTheme())
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const setTheme = useCallback((next: Theme) => persistTheme(next), [])
  const toggleTheme = useCallback(() => flipTheme(), [])

  return { theme, setTheme, toggleTheme }
}
