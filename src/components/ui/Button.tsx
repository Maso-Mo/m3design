import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from 'react'
import { cn } from '../../lib/cn'

export type ButtonVariant = 'primary' | 'outline' | 'ghost'
export type ButtonSize = 'sm' | 'md'

/**
 * Base commune à tous les boutons : forme, alignement, transition et anneau de
 * focus. Le rayon est `rounded-brand` (2 px) — angles droits, registre
 * architectural ; les seuls arrondis francs sont réservés aux pastilles rondes
 * (sélecteur de thème).
 */
const base = [
  'inline-flex items-center justify-center gap-2',
  'rounded-brand font-sans font-medium whitespace-nowrap',
  'transition-colors duration-200 ease-editorial',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink',
  'disabled:pointer-events-none disabled:opacity-50',
].join(' ')

const variants: Record<ButtonVariant, string> = {
  // Le rouge est l'accent unique du site : il sert au bouton d'action, jamais
  // de décoration.
  primary: 'bg-accent text-accent-contrast hover:bg-accent-hover',
  outline:
    'border border-line-strong text-strong hover:border-strong hover:bg-surface',
  ghost: 'text-muted hover:text-accent-ink',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'text-eyebrow h-9 px-4 uppercase',
  md: 'h-11 px-6 text-sm',
}

interface CommonButtonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  children: ReactNode
}

export type ButtonProps = CommonButtonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>

export type ButtonLinkProps = CommonButtonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children'>

/** Bouton d'action natif (`<button type="button">` par défaut). */
export function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * Même apparence, mais un lien (`<a>`) : c'est le bon choix dès que l'action
 * mène quelque part — un lien peut être ouvert dans un nouvel onglet, copié ou
 * indexé, ce qu'un bouton ne permet pas.
 */
export function ButtonLink({
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <a
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    >
      {children}
    </a>
  )
}
