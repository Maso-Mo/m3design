import { ArrowUp } from 'lucide-react'
import { navigationSections, site } from '../../data/site'
import { Container } from '../ui/Container'

/**
 * Pied de page : rappel de la marque, plan de la page, mentions.
 *
 * Il ne contient aucune coordonnée, celles-ci n'ayant pas encore été fournies :
 * elles seront ajoutées lorsque le contenu de la section « Contact » sera
 * défini. La colonne de liens reprend exactement la navigation principale —
 * l'ordre et les libellés viennent de `data/site.ts`.
 */
export function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-line bg-surface border-t">
      <Container className="py-10 sm:py-12 lg:py-20">
        <div className="grid gap-8 sm:gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-20">
          <div data-reveal="up" className="flex flex-col gap-4 lg:gap-5">
            <a
              href="#accueil"
              aria-label={`${site.name} — retour en haut de la page`}
              className="inline-flex w-fit items-center gap-2.5 lg:gap-3"
            >
              <img
                src="/images/branding/logos-icon.png"
                alt=""
                width={1254}
                height={1254}
                className="h-8 w-auto"
              />
              <span className="text-strong font-display text-xl tracking-tight">
                {site.name}
              </span>
            </a>
            <p className="text-muted max-w-sm text-sm">
              {site.discipline} — présentation, services, projets, processus et
              contact, réunis sur cette page.
            </p>
          </div>

          <nav
            aria-label="Sections du site"
            data-reveal="up"
            data-reveal-delay="1"
            className="border-line grid grid-cols-2 gap-x-8 gap-y-4 border-t pt-8 sm:gap-x-16 lg:gap-y-3 lg:border-t-0 lg:pt-0"
          >
            {navigationSections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="text-muted hover:text-accent-ink w-fit text-sm transition-colors duration-200 ease-editorial"
              >
                {section.label}
              </a>
            ))}
          </nav>
        </div>

        <div
          data-reveal="up"
          data-reveal-delay="2"
          className="border-line text-subtle mt-8 flex flex-col gap-3 border-t pt-6 text-xs sm:flex-row sm:items-center sm:justify-between lg:mt-14 lg:pt-8"
        >
          <p>
            © {year} {site.name}. Tous droits réservés.
          </p>
          <a
            href="#accueil"
            className="hover:text-accent-ink inline-flex w-fit items-center gap-2 transition-colors duration-200 ease-editorial"
          >
            <ArrowUp className="size-3.5" aria-hidden="true" />
            Retour en haut
          </a>
        </div>
      </Container>
    </footer>
  )
}
