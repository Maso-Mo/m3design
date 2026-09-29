import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import type { ProjectImage } from '../../data/projects'
import { cn } from '../../lib/cn'

interface ProjectLightboxProps {
  readonly projects: readonly ProjectImage[]
  readonly index: number
  readonly onSelect: (index: number) => void
  readonly onClose: () => void
  readonly onPrevious: () => void
  readonly onNext: () => void
}

/**
 * Vue détail immersive d'une réalisation. Les données disponibles se limitent
 * pour l'instant à l'image, son index et sa description visuelle : aucun nom,
 * lieu, millésime ou programme n'est donc ajouté artificiellement.
 */
export function ProjectLightbox({
  projects,
  index,
  onSelect,
  onClose,
  onPrevious,
  onNext,
}: ProjectLightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const project = projects[index]
  const total = projects.length
  const displayIndex = String(project.displayIndex).padStart(2, '0')

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const appRoot = document.getElementById('root')
    const wasAppInert = appRoot?.inert ?? false
    const previousBodyOverflow = document.body.style.overflow
    const previousDocumentOverflow = document.documentElement.style.overflow
    const scrollX = window.scrollX
    const scrollY = window.scrollY

    if (appRoot) appRoot.inert = true
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onPrevious()
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        onNext()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) {
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousDocumentOverflow
      document.removeEventListener('keydown', onKeyDown)
      if (appRoot) appRoot.inert = wasAppInert
      window.scrollTo(scrollX, scrollY)
      previouslyFocused?.focus()
    }
  }, [onClose, onNext, onPrevious])

  return createPortal(
    <div className="lightbox-enter bg-canvas text-strong fixed inset-0 z-[100] overflow-y-auto">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-detail-title"
        className="mx-auto flex min-h-full w-full max-w-[100rem] flex-col px-4 sm:px-8 lg:px-12"
      >
        <header className="border-line bg-canvas/95 sticky top-0 z-30 flex items-center justify-between gap-6 border-b py-4 backdrop-blur-md sm:py-5">
          <p className="text-subtle text-[0.625rem] tracking-[0.18em] uppercase sm:text-xs">
            M3Design / Réalisations
          </p>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Fermer la vue détail de la réalisation"
            className="text-strong hover:text-accent-ink inline-flex h-11 items-center gap-3 border-l border-line pl-5 text-xs tracking-[0.16em] uppercase transition-colors duration-200 ease-editorial"
          >
            Fermer
            <X className="size-5" aria-hidden="true" />
          </button>
        </header>

        <main className="grid gap-8 py-7 sm:py-10 lg:grid-cols-[minmax(0,1.9fr)_minmax(18rem,0.8fr)] lg:items-stretch lg:gap-12 xl:gap-16">
          <figure className="border-line bg-surface relative h-[min(56vh,44rem)] min-h-[18rem] overflow-hidden border-y sm:min-h-[28rem] lg:h-[min(50vh,42rem)]">
            <img
              key={project.id}
              src={project.image}
              alt={project.alt}
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="lightbox-image-enter size-full object-contain"
            />
            <span
              aria-hidden="true"
              className="absolute top-0 left-0 h-px w-24 bg-brand"
            />
          </figure>

          <aside
            key={`${project.id}-details`}
            className="lightbox-image-enter flex flex-col justify-center lg:py-8"
          >
            <p className="text-eyebrow text-accent-ink uppercase">
              Réalisation {displayIndex} / {String(total).padStart(2, '0')}
            </p>
            <h2
              id="project-detail-title"
              className="text-display text-strong mt-5"
            >
              Réalisation {displayIndex}
            </h2>
            <span aria-hidden="true" className="mt-7 h-px w-20 bg-brand" />
            <p className="text-muted mt-7 max-w-md text-base leading-8">
              {project.alt}
            </p>

            <nav
              aria-label="Navigation entre les réalisations"
              className="border-line mt-10 flex border-y"
            >
              <button
                type="button"
                onClick={onPrevious}
                aria-label="Afficher la réalisation précédente"
                className="text-strong hover:text-accent-ink inline-flex h-12 flex-1 items-center justify-start gap-3 border-r border-line pr-4 text-xs tracking-[0.12em] uppercase transition-colors duration-200 ease-editorial"
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                Précédente
              </button>
              <button
                type="button"
                onClick={onNext}
                aria-label="Afficher la réalisation suivante"
                className="text-strong hover:text-accent-ink inline-flex h-12 flex-1 items-center justify-end gap-3 pl-4 text-xs tracking-[0.12em] uppercase transition-colors duration-200 ease-editorial"
              >
                Suivante
                <ArrowRight className="size-4" aria-hidden="true" />
              </button>
            </nav>
          </aside>
        </main>

        <section
          aria-labelledby="other-projects-title"
          className="border-line mt-auto border-t pt-6 pb-8 sm:pt-8 sm:pb-10"
        >
          <div className="flex items-center justify-between gap-6">
            <h3
              id="other-projects-title"
              className="text-strong text-xs tracking-[0.18em] uppercase"
            >
              Autres réalisations
            </h3>
            <ArrowRight className="text-accent-ink size-4" aria-hidden="true" />
          </div>

          <div className="mt-5 overflow-x-auto overscroll-x-contain pb-3 [scrollbar-width:thin] sm:mt-6">
            <ol className="flex w-max gap-4 sm:gap-5">
              {projects.map((candidate, candidateIndex) => {
                const isActive = candidateIndex === index
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(candidateIndex)}
                      aria-current={isActive ? 'true' : undefined}
                      aria-label={`Afficher la réalisation ${candidateIndex + 1} sur ${total}`}
                      className="group/project relative block w-44 text-left sm:w-56 lg:w-64"
                    >
                      <span className="border-line bg-surface relative block aspect-[4/3] overflow-hidden border-y">
                        <img
                          src={candidate.image}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className={cn(
                            'size-full object-cover transition-[opacity,transform] duration-300 ease-editorial group-hover/project:scale-[1.015] group-focus-visible/project:scale-[1.015] motion-reduce:transition-none',
                            isActive ? 'opacity-100' : 'opacity-65',
                          )}
                        />
                        {isActive ? (
                          <span
                            aria-hidden="true"
                            className="absolute top-0 left-0 h-px w-16 bg-brand"
                          />
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          'mt-3 block text-[0.625rem] tracking-[0.16em] uppercase transition-colors duration-200 ease-editorial',
                          isActive ? 'text-accent-ink' : 'text-subtle',
                        )}
                      >
                        {String(candidate.displayIndex).padStart(2, '0')}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  )
}
