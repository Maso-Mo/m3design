import type { ReactNode } from 'react'
import { Footer } from './Footer'
import { Header } from './Header'

export interface LayoutProps {
  children: ReactNode
}

/**
 * Ossature de toutes les pages : en-tête, contenu, pied de page.
 *
 * Le lien « Aller au contenu » est le premier élément focusable de la page : au
 * clavier, un appui sur Tab permet de sauter les sept liens de la barre de
 * navigation. Il n'est visible qu'au focus.
 */
export function Layout({ children }: LayoutProps) {
  return (
    <div className="bg-canvas flex min-h-svh flex-col">
      <a
        href="#contenu"
        className="focus:bg-accent focus:text-accent-contrast focus:rounded-brand sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-60 focus:px-4 focus:py-2 focus:text-sm"
      >
        Aller au contenu
      </a>
      <Header />
      <main id="contenu" className="flex-1">
        {children}
      </main>
      <Footer />
    </div>
  )
}
