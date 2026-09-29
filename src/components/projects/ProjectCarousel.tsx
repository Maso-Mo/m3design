import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { ProjectImage } from '../../data/projects'
import { cn } from '../../lib/cn'
import { ProjectLightbox } from './ProjectLightbox'

const AUTO_SCROLL_PIXELS_PER_SECOND = 18
const INTERACTION_PAUSE_MS = 2800
const DRAG_THRESHOLD_PX = 6

interface ProjectCarouselProps {
  readonly projects: readonly ProjectImage[]
}

interface DragState {
  readonly pointerId: number
  readonly startX: number
  readonly startScrollLeft: number
}

function ProjectSlide({
  project,
  index,
  total,
  isClone,
  onOpen,
  onPointerPresenceChange,
  onFocusPresenceChange,
}: {
  readonly project: ProjectImage
  readonly index: number
  readonly total: number
  readonly isClone: boolean
  readonly onOpen: (index: number) => void
  readonly onPointerPresenceChange: (isPresent: boolean) => void
  readonly onFocusPresenceChange: (isPresent: boolean) => void
}) {
  return (
    <li
      role={isClone ? undefined : 'group'}
      aria-roledescription={isClone ? undefined : 'diapositive'}
      aria-label={isClone ? undefined : `${index + 1} sur ${total}`}
      className="w-[82vw] max-w-[40rem] shrink-0 sm:w-[68vw] lg:w-[50vw] xl:w-[42vw]"
    >
      <button
        type="button"
        tabIndex={isClone ? -1 : 0}
        onClick={() => onOpen(index)}
        onPointerEnter={() => onPointerPresenceChange(true)}
        onPointerLeave={() => onPointerPresenceChange(false)}
        onFocus={() => {
          if (!isClone) onFocusPresenceChange(true)
        }}
        onBlur={() => {
          if (!isClone) onFocusPresenceChange(false)
        }}
        aria-label={
          isClone
            ? undefined
            : `Ouvrir le détail de la réalisation ${index + 1} sur ${total}`
        }
        className="group/slide block w-full text-left"
      >
        <span className="border-line bg-elevated relative block aspect-[4/3] overflow-hidden border">
          <img
            src={project.image}
            alt={isClone ? '' : project.alt}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="size-full select-none object-cover transition-transform duration-700 ease-editorial group-hover/slide:scale-[1.015] group-focus-visible/slide:scale-[1.015] motion-reduce:transition-none"
          />
          <span
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-1/3 bg-linear-to-t from-black/45 to-transparent"
          />
          <span className="absolute right-0 bottom-0 bg-black/75 px-4 py-3 text-xs tracking-[0.18em] text-white uppercase backdrop-blur-sm sm:px-5 sm:py-4">
            <span className="text-brand">
              {String(project.displayIndex).padStart(2, '0')}
            </span>{' '}
            / {String(total).padStart(2, '0')}
          </span>
        </span>
      </button>
    </li>
  )
}

/**
 * Galerie horizontale à défilement continu.
 *
 * La seconde série d'images assure la continuité visuelle, mais reste masquée
 * aux technologies d'assistance et hors de l'ordre de tabulation. La distance
 * exacte entre les deux premiers éléments identiques sert de longueur de
 * boucle : la normalisation de `scrollLeft` est ainsi invisible.
 */
export function ProjectCarousel({ projects }: ProjectCarouselProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const draggedRef = useRef(false)
  const pauseUntilRef = useRef(0)
  const [isProjectHovered, setIsProjectHovered] = useState(false)
  const [isProjectFocused, setIsProjectFocused] = useState(false)
  const [isPointerActive, setIsPointerActive] = useState(false)
  const [isInViewport, setIsInViewport] = useState(false)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const isPaused =
    !isInViewport ||
    isProjectHovered ||
    isProjectFocused ||
    isPointerActive ||
    lightboxIndex !== null

  const getCycleWidth = useCallback(() => {
    const viewport = viewportRef.current
    const original = viewport?.querySelector<HTMLElement>(
      '[data-carousel-set="original"]',
    )
    const clone = viewport?.querySelector<HTMLElement>(
      '[data-carousel-set="clone"]',
    )
    return original && clone ? clone.offsetLeft - original.offsetLeft : 0
  }, [])

  const normalizeScrollPosition = useCallback(() => {
    const viewport = viewportRef.current
    const cycleWidth = getCycleWidth()
    if (!viewport || cycleWidth <= 0) {
      return
    }
    while (viewport.scrollLeft >= cycleWidth) {
      viewport.scrollLeft -= cycleWidth
    }
  }, [getCycleWidth])

  const pauseAfterInteraction = useCallback(() => {
    pauseUntilRef.current = performance.now() + INTERACTION_PAUSE_MS
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof IntersectionObserver === 'undefined') {
      setIsInViewport(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsInViewport(Boolean(entry?.isIntersecting)),
      { rootMargin: '160px 0px', threshold: 0.01 },
    )
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updatePreference = () => setPrefersReducedMotion(media.matches)
    updatePreference()
    media.addEventListener('change', updatePreference)
    return () => media.removeEventListener('change', updatePreference)
  }, [])

  useEffect(() => {
    if (prefersReducedMotion || !isInViewport) {
      return
    }

    let frame = 0
    let previousTime = performance.now()
    let autoPosition = viewportRef.current?.scrollLeft ?? 0

    const tick = (time: number) => {
      const viewport = viewportRef.current
      const elapsed = Math.min(time - previousTime, 64)
      previousTime = time

      if (
        viewport &&
        !isPaused &&
        time >= pauseUntilRef.current &&
        document.visibilityState === 'visible'
      ) {
        autoPosition += (AUTO_SCROLL_PIXELS_PER_SECOND * elapsed) / 1000
        const cycleWidth = getCycleWidth()
        if (cycleWidth > 0 && autoPosition >= cycleWidth) {
          autoPosition -= cycleWidth
        }
        viewport.scrollLeft = autoPosition
      } else if (viewport) {
        // Resynchronise l'accumulateur après tout déplacement manuel.
        autoPosition = viewport.scrollLeft
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [getCycleWidth, isInViewport, isPaused, prefersReducedMotion])

  const moveByOneSlide = useCallback(
    (direction: -1 | 1) => {
      const viewport = viewportRef.current
      const firstSlide = viewport?.querySelector<HTMLElement>(
        '[data-carousel-set="original"] > li',
      )
      if (!viewport || !firstSlide) {
        return
      }

      const cycleWidth = getCycleWidth()
      if (direction < 0 && viewport.scrollLeft < firstSlide.offsetWidth) {
        viewport.scrollLeft += cycleWidth
      }

      pauseAfterInteraction()
      viewport.scrollBy({
        left: direction * (firstSlide.offsetWidth + 20),
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      })
    },
    [getCycleWidth, pauseAfterInteraction, prefersReducedMotion],
  )

  const openLightbox = useCallback((index: number) => {
    if (draggedRef.current) {
      draggedRef.current = false
      return
    }
    setIsProjectHovered(false)
    setLightboxIndex(index)
  }, [])

  const closeLightbox = useCallback(() => setLightboxIndex(null), [])
  const showPrevious = useCallback(() => {
    setLightboxIndex((current) =>
      current === null
        ? null
        : (current - 1 + projects.length) % projects.length,
    )
  }, [projects.length])
  const showNext = useCallback(() => {
    setLightboxIndex((current) =>
      current === null ? null : (current + 1) % projects.length,
    )
  }, [projects.length])

  const finishPointerInteraction = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current
      if (dragRef.current?.pointerId === event.pointerId) {
        dragRef.current = null
        if (viewport?.hasPointerCapture(event.pointerId)) {
          viewport.releasePointerCapture(event.pointerId)
        }
      }
      setIsPointerActive(false)
      pauseAfterInteraction()
      normalizeScrollPosition()
    },
    [normalizeScrollPosition, pauseAfterInteraction],
  )

  return (
    <div
      role="region"
      aria-roledescription="carrousel"
      aria-label="Réalisations M3Design"
    >
      <div className="mb-6 flex items-end justify-between gap-8">
        <p className="text-subtle text-xs tracking-[0.18em] uppercase">
          <span className="text-accent-ink">01</span> —{' '}
          {String(projects.length).padStart(2, '0')}
        </p>
        <div className="border-line flex border-y">
          <button
            type="button"
            onClick={() => moveByOneSlide(-1)}
            aria-label="Faire défiler vers la réalisation précédente"
            className="text-strong hover:text-accent-ink inline-flex h-12 items-center gap-2 border-r border-line px-4 text-xs tracking-[0.14em] uppercase transition-colors duration-200 ease-editorial sm:px-5"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Précédente</span>
          </button>
          <button
            type="button"
            onClick={() => moveByOneSlide(1)}
            aria-label="Faire défiler vers la réalisation suivante"
            className="text-strong hover:text-accent-ink inline-flex h-12 items-center gap-2 px-4 text-xs tracking-[0.14em] uppercase transition-colors duration-200 ease-editorial sm:px-5"
          >
            <span className="hidden sm:inline">Suivante</span>
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        tabIndex={0}
        aria-label="Galerie horizontale. Utilisez les flèches gauche et droite pour parcourir les images."
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            moveByOneSlide(event.key === 'ArrowLeft' ? -1 : 1)
          }
        }}
        onPointerDown={(event) => {
          setIsPointerActive(true)
          pauseAfterInteraction()
          draggedRef.current = false

          if (event.pointerType !== 'mouse' || event.button !== 0) {
            return
          }

          const viewport = viewportRef.current
          if (!viewport) {
            return
          }
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startScrollLeft: viewport.scrollLeft,
          }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          const viewport = viewportRef.current
          if (!drag || !viewport || drag.pointerId !== event.pointerId) {
            return
          }
          const distance = event.clientX - drag.startX
          if (!draggedRef.current && Math.abs(distance) <= DRAG_THRESHOLD_PX) {
            return
          }
          let startScrollLeft = drag.startScrollLeft
          if (!draggedRef.current) {
            draggedRef.current = true
            const cycleWidth = getCycleWidth()
            if (distance > 0 && startScrollLeft < 1 && cycleWidth > 0) {
              startScrollLeft += cycleWidth
              viewport.scrollLeft = startScrollLeft
              dragRef.current = { ...drag, startScrollLeft }
            }
            viewport.setPointerCapture(event.pointerId)
          }
          viewport.scrollLeft = startScrollLeft - distance
        }}
        onPointerUp={finishPointerInteraction}
        onPointerCancel={finishPointerInteraction}
        className={cn(
          'overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          'focus-visible:outline-offset-4',
          isPointerActive ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <div className="flex w-max gap-5 sm:gap-6">
          <ol
            data-carousel-set="original"
            aria-label="Liste des réalisations"
            className="flex gap-5 sm:gap-6"
          >
            {projects.map((project, index) => (
              <ProjectSlide
                key={project.id}
                project={project}
                index={index}
                total={projects.length}
                isClone={false}
                onOpen={openLightbox}
                onPointerPresenceChange={setIsProjectHovered}
                onFocusPresenceChange={setIsProjectFocused}
              />
            ))}
          </ol>
          <ol
            data-carousel-set="clone"
            aria-hidden="true"
            className="flex gap-5 sm:gap-6"
          >
            {projects.map((project, index) => (
              <ProjectSlide
                key={`${project.id}-clone`}
                project={project}
                index={index}
                total={projects.length}
                isClone
                onOpen={openLightbox}
                onPointerPresenceChange={setIsProjectHovered}
                onFocusPresenceChange={setIsProjectFocused}
              />
            ))}
          </ol>
        </div>
      </div>

      <p className="text-subtle mt-5 text-xs leading-5 sm:hidden">
        Faites glisser pour parcourir les images, puis touchez-en une pour
        ouvrir son détail.
      </p>

      {lightboxIndex !== null ? (
        <ProjectLightbox
          projects={projects}
          index={lightboxIndex}
          onSelect={setLightboxIndex}
          onClose={closeLightbox}
          onPrevious={showPrevious}
          onNext={showNext}
        />
      ) : null}
    </div>
  )
}
