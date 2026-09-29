import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface SectionPlaceholderProps {
  /** Ce qui reste à intégrer dans la section. */
  children: ReactNode
  className?: string
}

/**
 * Emplacement réservé, en attendant le contenu définitif d'une section.
 *
 * Volontairement explicite et sobre : il montre l'ancre, les proportions et le
 * rythme, sans rien inventer du contenu client. Chaque section remplacera ce
 * bloc par sa mise en page réelle.
 */
export function SectionPlaceholder({
  children,
  className,
}: SectionPlaceholderProps) {
  return (
    <div
      className={cn(
        'flex min-h-44 items-center justify-center',
        'border border-dashed border-line-strong/70 bg-elevated/40 p-8',
        className,
      )}
    >
      <p className="max-w-prose text-center text-sm text-subtle">{children}</p>
    </div>
  )
}
