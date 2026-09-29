import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Container } from './Container'

export interface SectionProps {
  /** Identifiant d'ancrage : c'est la cible des liens de navigation. */
  id: string
  /** Surtitre : petites capitales espacées, en rouge d'accent. */
  eyebrow?: string
  /** Titre de la section ; omis pour le Hero, qui a sa propre mise en page. */
  title?: string
  /** Identifiant d'un titre personnalisé rendu par le contenu de la section. */
  labelledBy?: string
  /** Alterne les fonds pour rythmer le défilement. */
  tone?: 'default' | 'surface'
  /** Supprime la respiration verticale (sections à mise en page libre). */
  flush?: boolean
  className?: string
  children: ReactNode
}

/**
 * Enveloppe commune à toutes les sections de la page.
 *
 * Elle garantit trois choses identiques partout : l'ancre (`id`), le rythme
 * vertical (`py-section`), et l'en-tête de section (surtitre + titre, reliés
 * par `aria-labelledby`). Les sections restent ainsi purement décoratives dans
 * leur contenu : leur cadre, lui, est déjà cohérent.
 */
export function Section({
  id,
  eyebrow,
  title,
  labelledBy,
  tone = 'default',
  flush = false,
  className,
  children,
}: SectionProps) {
  const hasHeader = Boolean(eyebrow ?? title)

  return (
    <section
      id={id}
      aria-labelledby={labelledBy ?? (title ? `${id}-titre` : undefined)}
      className={cn(
        'relative',
        tone === 'surface' ? 'bg-surface' : 'bg-canvas',
        !flush && 'py-section',
        className,
      )}
    >
      <Container>
        {hasHeader ? (
          <header className="mb-12 flex max-w-3xl flex-col gap-4 lg:mb-16">
            {eyebrow ? (
              <p className="text-eyebrow text-accent-ink uppercase">
                {eyebrow}
              </p>
            ) : null}
            {title ? (
              <h2 id={`${id}-titre`} className="text-display-sm text-strong">
                {title}
              </h2>
            ) : null}
          </header>
        ) : null}
        {children}
      </Container>
    </section>
  )
}
