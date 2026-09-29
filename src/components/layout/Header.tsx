import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react'
import { ArrowRight, Menu, X } from 'lucide-react'
import { actions, navigationSections, sectionIds, site } from '../../data/site'
import { useActiveSection } from '../../hooks/useActiveSection'
import { cn } from '../../lib/cn'
import { ButtonLink } from '../ui/Button'
import { Container } from '../ui/Container'
import { ThemeToggle } from '../ui/ThemeToggle'

// POSITION HEADER : modifier cette valeur pour monter ou descendre la barre de navigation. Une valeur plus négative la fait monter.
const HEADER_CONTENT_Y = '-10rem'

// REPÈRE HEADER : réserve structurelle qui absorbe la remontée sans laisser les contrôles sortir du viewport.
const HEADER_POSITION_ORIGIN = '1.25rem'

// LIMITE VISIBLE HEADER : borne physique atteinte quand HEADER_CONTENT_Y ferait sortir les contrôles du viewport.
const HEADER_VISIBLE_TOP_LIMIT = '-0.875rem'

// STYLE HEADER : réglages visuels centralisés pour les états repos et défilement.
const HEADER_SCROLL_THRESHOLD = 16
const HEADER_LIGHT_BACKGROUND_REST = 'rgb(255 255 255 / 0.94)'
const HEADER_LIGHT_BACKGROUND_SCROLLED = 'rgb(255 255 255 / 0.985)'
const HEADER_LIGHT_BORDER_REST = 'rgb(15 23 42 / 0.12)'
const HEADER_LIGHT_BORDER_SCROLLED = 'rgb(100 116 139 / 0.24)'
const HEADER_LIGHT_SHADOW_REST = '0 8px 22px -18px rgb(15 23 42 / 0.22)'
const HEADER_LIGHT_SHADOW_SCROLLED =
  '0 14px 34px -20px rgb(15 23 42 / 0.32), 0 1px 0 rgb(148 163 184 / 0.1)'
const HEADER_DARK_BACKGROUND_REST = 'rgb(7 9 14 / 0.94)'
const HEADER_DARK_BACKGROUND_SCROLLED = 'rgb(5 8 13 / 0.985)'
const HEADER_DARK_BORDER_REST = 'rgb(255 255 255 / 0.1)'
const HEADER_DARK_BORDER_SCROLLED = 'rgb(148 163 184 / 0.24)'
const HEADER_DARK_SHADOW_REST = '0 8px 22px -18px rgb(0 0 0 / 0.7)'
const HEADER_DARK_SHADOW_SCROLLED =
  '0 14px 34px -20px rgb(0 0 0 / 0.9), 0 1px 0 rgb(148 163 184 / 0.08)'
const HEADER_BLUR_REST = '2px'
const HEADER_BLUR_SCROLLED = '8px'

// ESPACEMENTS HEADER : marges du groupe de navigation et séparation avec le Hero.
const HEADER_GROUP_MARGIN_TOP = '15px'
const HEADER_GROUP_MARGIN_BOTTOM = '10px'
const HEADER_MARGIN_BOTTOM = '15px'

/**
 * Barre de navigation du site.
 *
 * Trois principes :
 *
 *  - elle est POSÉE sur le bandeau d'accueil, mais une surface claire en thème
 *    clair et anthracite en thème sombre sépare nettement les deux zones. Au
 *    défilement, cette surface gagne légèrement en densité, en flou et en ombre
 *    sans changer de hauteur ; le panneau déroulant conserve son propre fond
 *    opaque ;
 *  - elle indique la section en cours de lecture (libellé et soulignement
 *    rouges), calculée par `useActiveSection` ;
 *  - en dessous de `xl`, les liens basculent dans un panneau vertical : un seul
 *    bouton le commande (`aria-expanded` / `aria-controls`), avec fermeture par
 *    Échap, par un clic sur un lien, ou au passage sur grand écran. Le
 *    défilement de la page est bloqué pendant que le panneau est ouvert.
 *
 * Le seuil est `xl` et non `lg` : les six liens de navigation, le sélecteur de
 * thème et le bouton « Demander un devis » ont besoin de cette largeur pour
 * tenir sur une seule ligne sans se tasser.
 */
export function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isScrolled, setIsScrolled] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const activeId = useActiveSection(sectionIds)

  useEffect(() => {
    let frame = 0
    const updateScrolledState = () => {
      setIsScrolled(window.scrollY > HEADER_SCROLL_THRESHOLD)
    }
    const onScroll = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        updateScrolledState()
      })
    }

    updateScrolledState()
    window.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [])

  useEffect(() => {
    if (!isMenuOpen) {
      return
    }

    const media = window.matchMedia('(min-width: 80rem)')
    const previousOverflow = document.body.style.overflow
    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('a[href]')?.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false)
        window.requestAnimationFrame(() => menuButtonRef.current?.focus())
      }
    }
    const onBreakpointChange = () => {
      if (media.matches) {
        setIsMenuOpen(false)
      }
    }

    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    media.addEventListener('change', onBreakpointChange)

    return () => {
      document.body.style.overflow = previousOverflow
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown)
      media.removeEventListener('change', onBreakpointChange)
    }
  }, [isMenuOpen])

  const navigateFromMenu = (
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    event.preventDefault()
    setIsMenuOpen(false)
    window.requestAnimationFrame(() => {
      window.history.pushState(null, '', href)
      document.getElementById(href.slice(1))?.scrollIntoView({ block: 'start' })
    })
  }

  return (
    <header
      style={
        {
          '--header-content-y': HEADER_CONTENT_Y,
          '--header-position-origin': HEADER_POSITION_ORIGIN,
          '--header-visible-top-limit': HEADER_VISIBLE_TOP_LIMIT,
          marginBottom: HEADER_MARGIN_BOTTOM,
        } as CSSProperties
      }
      className="sticky top-0 z-50"
      data-scrolled={isScrolled || undefined}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-full xl:h-[4.3125rem]"
      >
        <div
          style={{
            backgroundColor: isScrolled
              ? HEADER_LIGHT_BACKGROUND_SCROLLED
              : HEADER_LIGHT_BACKGROUND_REST,
            borderColor: isScrolled
              ? HEADER_LIGHT_BORDER_SCROLLED
              : HEADER_LIGHT_BORDER_REST,
            boxShadow: isScrolled
              ? HEADER_LIGHT_SHADOW_SCROLLED
              : HEADER_LIGHT_SHADOW_REST,
            backdropFilter: `blur(${isScrolled ? HEADER_BLUR_SCROLLED : HEADER_BLUR_REST})`,
            WebkitBackdropFilter: `blur(${isScrolled ? HEADER_BLUR_SCROLLED : HEADER_BLUR_REST})`,
          }}
          className="absolute inset-0 border-b transition-[background-color,border-color,box-shadow,backdrop-filter] duration-300 ease-editorial motion-reduce:transition-none dark:hidden"
        />
        <div
          style={{
            backgroundColor: isScrolled
              ? HEADER_DARK_BACKGROUND_SCROLLED
              : HEADER_DARK_BACKGROUND_REST,
            borderColor: isScrolled
              ? HEADER_DARK_BORDER_SCROLLED
              : HEADER_DARK_BORDER_REST,
            boxShadow: isScrolled
              ? HEADER_DARK_SHADOW_SCROLLED
              : HEADER_DARK_SHADOW_REST,
            backdropFilter: `blur(${isScrolled ? HEADER_BLUR_SCROLLED : HEADER_BLUR_REST})`,
            WebkitBackdropFilter: `blur(${isScrolled ? HEADER_BLUR_SCROLLED : HEADER_BLUR_REST})`,
          }}
          className="absolute inset-0 hidden border-b transition-[background-color,border-color,box-shadow,backdrop-filter] duration-300 ease-editorial motion-reduce:transition-none dark:block"
        />
        <span
          className={cn(
            'absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-slate-500/15 to-transparent transition-opacity duration-300 motion-reduce:transition-none dark:via-slate-200/20',
            isScrolled ? 'opacity-100' : 'opacity-35',
          )}
        />
      </div>

      <div
        style={{
          marginTop: HEADER_GROUP_MARGIN_TOP,
          marginBottom: HEADER_GROUP_MARGIN_BOTTOM,
        }}
        className="relative xl:top-[max(var(--header-visible-top-limit),calc(var(--header-position-origin)+var(--header-content-y)))]"
      >
        <Container className="h-header flex items-center justify-between gap-6 text-zinc-950 dark:text-white">
          <a
            href="#accueil"
            onClick={(event) => {
              if (isMenuOpen) navigateFromMenu(event, '#accueil')
            }}
            aria-label={`${site.name} — retour en haut de la page`}
            className="inline-flex shrink-0 items-center bg-white/95 px-0.5 dark:bg-transparent"
          >
            {/* Le logotype est fourni en deux versions COMPLÈTES — une par thème :
              « Design » y est blanc pour le thème sombre, noir pour le thème
              clair. On affiche exclusivement ces assets, sans reconstruire la
              marque avec du texte HTML. Les deux variantes cohabitent dans le
              document pour que la bascule de thème soit instantanée. */}
            <img
              src="/images/branding/logos-light.png"
              alt=""
              width={1536}
              height={1024}
              className="h-12 w-auto dark:hidden sm:h-13 xl:h-11"
            />
            <img
              src="/images/branding/logos-dark.png"
              alt=""
              width={1536}
              height={1024}
              className="hidden h-12 w-auto dark:block sm:h-13 xl:h-11"
            />
          </a>

          <nav
            aria-label="Navigation principale"
            className="hidden items-center gap-5 xl:flex 2xl:gap-8"
          >
            {navigationSections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                aria-current={activeId === section.id ? 'true' : undefined}
                className={cn(
                  'relative py-1 text-xs tracking-[0.16em] uppercase',
                  'transition-colors duration-200 ease-editorial',
                  activeId === section.id
                    ? 'text-brand'
                    : 'text-zinc-800 hover:text-brand dark:text-white/70 dark:hover:text-brand',
                )}
              >
                {section.label}
                <span
                  aria-hidden="true"
                  className={cn(
                    'bg-brand absolute inset-x-0 -bottom-0.5 h-px',
                    'origin-left transition-transform duration-300 ease-editorial',
                    activeId === section.id ? 'scale-x-100' : 'scale-x-0',
                  )}
                />
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeToggle className="border-black/20 text-zinc-700 hover:border-brand/60 hover:text-brand dark:border-white/25 dark:text-white/75 dark:hover:border-brand/70 dark:hover:text-brand" />
            <ButtonLink
              href={actions.quote.href}
              size="md"
              className="hidden gap-2.5 sm:inline-flex"
            >
              {actions.quote.label}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </ButtonLink>
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setIsMenuOpen((open) => !open)}
              aria-expanded={isMenuOpen}
              aria-controls="menu-principal"
              aria-label={isMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
              className={cn(
                'inline-flex size-10 items-center justify-center xl:hidden',
                'rounded-full border border-black/20 text-zinc-900 dark:border-white/25 dark:text-white',
                'transition-colors duration-200 ease-editorial hover:border-brand/60 hover:text-brand dark:hover:border-brand/70 dark:hover:text-brand',
              )}
            >
              {isMenuOpen ? (
                <X className="size-5" aria-hidden="true" />
              ) : (
                <Menu className="size-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </Container>
      </div>

      {/* Le panneau reste dans le document (il est référencé par
          `aria-controls`) mais ne s'affiche que sur petit écran, et seulement
          lorsqu'il est ouvert : masqué, ses liens ne sont pas focalisables. */}
      <div
        ref={menuRef}
        id="menu-principal"
        className={cn(
          'menu-enter border-line bg-canvas border-t xl:hidden',
          !isMenuOpen && 'hidden',
        )}
      >
        <Container className="max-h-[calc(100svh-var(--spacing-header))] overflow-y-auto py-6">
          <nav aria-label="Sections du site" className="flex flex-col">
            {navigationSections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                onClick={(event) => navigateFromMenu(event, `#${section.id}`)}
                className="text-strong border-line/70 hover:text-brand border-b py-4 text-sm tracking-[0.14em] uppercase transition-colors duration-200 ease-editorial"
              >
                {section.label}
              </a>
            ))}
          </nav>
          <ButtonLink
            href={actions.quote.href}
            size="md"
            onClick={(event) => navigateFromMenu(event, actions.quote.href)}
            className="mt-6 w-full sm:hidden"
          >
            {actions.quote.label}
            <ArrowRight className="size-4" aria-hidden="true" />
          </ButtonLink>
        </Container>
      </div>
    </header>
  )
}
