import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export type ContainerSize = 'narrow' | 'content' | 'wide'

const sizes: Record<ContainerSize, string> = {
  narrow: 'max-w-narrow',
  content: 'max-w-content',
  wide: 'max-w-wide',
}

export interface ContainerProps {
  /** Largeur maximale : `content` par défaut, `narrow` pour un texte long. */
  size?: ContainerSize
  className?: string
  children: ReactNode
}

/**
 * Gouttières latérales et largeur maximale du site, en un seul endroit.
 *
 * Les sections n'ont donc jamais à se soucier des marges, et le rythme
 * horizontal reste identique d'un bout à l'autre de la page : c'est la
 * colonne vertébrale de la mise en page.
 */
export function Container({
  size = 'content',
  className,
  children,
}: ContainerProps) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-6 sm:px-8 lg:px-12',
        sizes[size],
        className,
      )}
    >
      {children}
    </div>
  )
}
