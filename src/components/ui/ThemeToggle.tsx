import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../../hooks/useTheme'
import { cn } from '../../lib/cn'

export interface ThemeToggleProps {
  className?: string
}

/**
 * Sélecteur de thème clair / sombre.
 *
 * Le libellé accessible DÉCRIT l'action à venir (« Passer au thème clair »
 * lorsque le thème sombre est actif) : c'est ce qu'attend un lecteur d'écran,
 * et cela évite d'avoir à deviner l'état courant de l'icône. Aucune préférence
 * n'est imposée au premier chargement : tant que le visiteur n'a pas cliqué,
 * le site suit son système.
 */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'
  const label = isDark ? 'Passer au thème clair' : 'Passer au thème sombre'

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-10 items-center justify-center',
        'rounded-full border border-line text-muted',
        'transition-colors duration-200 ease-editorial',
        'hover:border-line-strong hover:text-strong',
        className,
      )}
    >
      {isDark ? (
        <Sun className="size-4" aria-hidden="true" />
      ) : (
        <Moon className="size-4" aria-hidden="true" />
      )}
    </button>
  )
}
