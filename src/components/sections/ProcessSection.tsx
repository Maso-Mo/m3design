import { useEffect, useRef, useState } from 'react'
import { processIntro, processSteps } from '../../data/process'
import { getSection } from '../../data/site'
import { cn } from '../../lib/cn'
import { Container } from '../ui/Container'

const section = getSection('processus')

type ProcessDirection = 'forward' | 'backward'

interface ProcessTransition {
  readonly activeIndex: number
  readonly outgoingIndex: number | null
  readonly direction: ProcessDirection
  readonly sequence: number
}

/**
 * Section « Processus » — ancre `#processus`.
 *
 * Sur grand écran, le visuel reste ancré tandis que les quatre lectures
 * éditoriales défilent. Un observateur léger sélectionne l'étape la plus proche
 * du centre de lecture ; il ne modifie jamais la position de défilement. Avant
 * `xl`, chaque image retrouve sa place sous son texte et aucun sticky n'est
 * conservé.
 */
export function ProcessSection() {
  const [transition, setTransition] = useState<ProcessTransition>({
    activeIndex: 0,
    outgoingIndex: null,
    direction: 'forward',
    sequence: 0,
  })
  const activeIndexRef = useRef(0)
  const stepRefs = useRef<Array<HTMLElement | null>>([])
  const inlineImageRefs = useRef<Array<HTMLElement | null>>([])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return
    }

    const steps = stepRefs.current.filter(
      (step): step is HTMLElement => step !== null,
    )
    if (steps.length === 0) {
      return
    }

    const updateActiveStep = () => {
      const readingLine = window.innerHeight * 0.44
      let closestIndex = 0
      let closestDistance = Number.POSITIVE_INFINITY

      for (const step of steps) {
        const rect = step.getBoundingClientRect()
        const index = Number(step.dataset.processIndex)
        const distance = Math.abs(rect.top + rect.height * 0.35 - readingLine)
        if (distance < closestDistance) {
          closestDistance = distance
          closestIndex = index
        }
      }

      const previousIndex = activeIndexRef.current
      if (closestIndex === previousIndex) return

      activeIndexRef.current = closestIndex
      setTransition((current) => ({
        activeIndex: closestIndex,
        outgoingIndex: previousIndex,
        direction: closestIndex > previousIndex ? 'forward' : 'backward',
        sequence: current.sequence + 1,
      }))
    }

    const observer = new IntersectionObserver(updateActiveStep, {
      rootMargin: '-18% 0px -38% 0px',
      threshold: [0, 0.25, 0.5, 0.75],
    })

    for (const step of steps) {
      observer.observe(step)
    }
    updateActiveStep()

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const images = inlineImageRefs.current.filter(
      (image): image is HTMLElement => image !== null,
    )
    if (images.length === 0) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (reducedMotion.matches || typeof IntersectionObserver === 'undefined') {
      for (const image of images) image.classList.add('is-process-visible')
      return
    }

    let previousScrollY = window.scrollY
    const observer = new IntersectionObserver(
      (entries) => {
        const nextScrollY = window.scrollY
        const direction: ProcessDirection =
          nextScrollY >= previousScrollY ? 'forward' : 'backward'
        previousScrollY = nextScrollY

        for (const entry of entries) {
          const image = entry.target as HTMLElement
          if (entry.isIntersecting) {
            image.classList.add('is-process-resetting')
            image.classList.remove('is-process-visible')
            image.dataset.processNavigationDirection = direction
            // Fige d'abord le bon côté de départ, puis réactive la transition.
            // Sans cette séparation, un retour rapide pourrait repartir depuis
            // la translation de la descente précédente.
            void image.offsetWidth
            image.classList.remove('is-process-resetting')
            void image.offsetWidth
            image.classList.add('is-process-visible')
          } else {
            image.classList.add('is-process-resetting')
            image.classList.remove('is-process-visible')
            void image.offsetWidth
            image.classList.remove('is-process-resetting')
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.08 },
    )

    for (const image of images) observer.observe(image)
    return () => observer.disconnect()
  }, [])

  const { activeIndex, outgoingIndex, direction, sequence } = transition

  const activeStep = processSteps[activeIndex]

  return (
    <section
      id={section.id}
      aria-labelledby="processus-titre"
      className="border-line bg-surface relative overflow-clip border-t py-20 sm:py-24 lg:py-32"
    >
      <span
        aria-hidden="true"
        data-reveal="line-x"
        className="absolute top-0 left-1/2 h-px w-[clamp(6rem,28vw,28rem)] -translate-x-1/2 bg-brand"
      />

      <Container size="wide">
        <header className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.55fr)] lg:items-end lg:gap-16">
          <div data-reveal="up">
            <div className="mb-8 flex items-center gap-4 sm:mb-10">
              <span aria-hidden="true" className="h-px w-10 bg-brand" />
              <p className="text-eyebrow text-accent-ink uppercase">
                {section.label}
              </p>
            </div>
            <h2
              id="processus-titre"
              className="text-display-lg text-strong max-w-[11ch] whitespace-pre-line"
            >
              {processIntro.title}
            </h2>
          </div>

          <p
            data-reveal="up"
            data-reveal-delay="1"
            className="text-muted max-w-lg text-base leading-8 sm:text-lg sm:leading-9 lg:pb-2"
          >
            {processIntro.description}
          </p>
        </header>

        <div className="mt-16 grid items-start gap-16 sm:mt-20 xl:mt-28 xl:grid-cols-[minmax(0,1.15fr)_minmax(23rem,0.85fr)] xl:gap-20 2xl:gap-28">
          <figure
            data-reveal="image"
            className="hidden xl:sticky xl:top-[calc(var(--spacing-header)+2rem)] xl:block"
          >
            <div className="border-line text-subtle flex items-center justify-between gap-6 border-y py-3 text-xs tracking-[0.18em] uppercase">
              <span>Progression visuelle</span>
              <span>
                <span className="text-accent-ink">
                  {String(activeIndex + 1).padStart(2, '0')}
                </span>{' '}
                / {String(processSteps.length).padStart(2, '0')}
              </span>
            </div>

            <div className="bg-elevated relative aspect-[16/10] overflow-hidden">
              {processSteps.map((step, index) => {
                const isActive = index === activeIndex
                const isOutgoing = index === outgoingIndex
                return (
                  <img
                    key={step.id}
                    src={step.image}
                    alt={isActive ? step.alt : ''}
                    aria-hidden={!isActive || undefined}
                    width={step.width}
                    height={step.height}
                    loading="lazy"
                    decoding="async"
                    className={cn(
                      'process-stage-image absolute inset-0 size-full object-contain',
                      isActive &&
                        (outgoingIndex === null
                          ? 'is-process-active z-30'
                          : cn(
                              'is-process-active z-30',
                              direction === 'forward'
                                ? 'is-process-entering-forward'
                                : 'is-process-entering-backward',
                            )),
                      isOutgoing &&
                        cn(
                          'z-20',
                          direction === 'forward'
                            ? 'is-process-leaving-forward'
                            : 'is-process-leaving-backward',
                        ),
                      !isActive && !isOutgoing && 'z-0',
                    )}
                    onAnimationEnd={() => {
                      if (!isOutgoing) return
                      setTransition((current) =>
                        current.sequence === sequence
                          ? { ...current, outgoingIndex: null }
                          : current,
                      )
                    }}
                  />
                )
              })}

              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-px bg-brand"
              />
              <span
                aria-hidden="true"
                className="absolute top-0 left-0 h-px w-28 bg-brand"
              />
            </div>

            <figcaption className="border-line text-subtle flex items-center justify-between gap-6 border-b py-4 text-xs tracking-[0.15em] uppercase">
              <span>{activeStep.caption}</span>
              <span aria-hidden="true">M3 / Processus</span>
            </figcaption>
          </figure>

          <ol>
            {processSteps.map((step, index) => {
              const isActive = index === activeIndex
              return (
                <li key={step.id}>
                  <article
                    ref={(element) => {
                      stepRefs.current[index] = element
                    }}
                    data-process-index={index}
                    aria-current={isActive ? 'step' : undefined}
                    className="border-line relative border-t py-10 sm:py-12 xl:min-h-[34rem] xl:py-16"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute top-0 left-0 h-px origin-left bg-brand transition-[width,opacity] duration-500 ease-editorial motion-reduce:transition-none',
                        isActive ? 'w-24 opacity-100' : 'w-8 opacity-35',
                      )}
                    />

                    <div
                      data-reveal="up"
                      data-reveal-delay={String(Math.min(index + 1, 3))}
                    >
                      <div
                        className={cn(
                          'grid gap-6 transition-[opacity,translate] duration-500 ease-editorial motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none sm:grid-cols-[5rem_1fr] sm:gap-8',
                          isActive
                            ? 'translate-y-0 opacity-100'
                            : 'translate-y-3 opacity-70',
                        )}
                      >
                        <p
                          className={cn(
                            'font-display text-5xl font-light transition-colors duration-500 ease-editorial motion-reduce:transition-none sm:text-6xl',
                            isActive ? 'text-accent-ink' : 'text-subtle',
                          )}
                        >
                          {String(index + 1).padStart(2, '0')}
                        </p>

                        <div>
                          <h3 className="text-display-sm text-strong uppercase">
                            {step.title}
                          </h3>
                          <p className="text-muted mt-5 max-w-lg text-sm leading-7 sm:text-base sm:leading-8">
                            {step.description}
                          </p>
                        </div>
                      </div>
                    </div>

                    <figure
                      ref={(element) => {
                        inlineImageRefs.current[index] = element
                      }}
                      data-process-navigation-direction="forward"
                      className="process-inline-image mt-8 sm:ml-[7rem] sm:max-w-[40rem] xl:hidden"
                    >
                      <div className="border-line bg-elevated overflow-hidden border">
                        <img
                          src={step.image}
                          alt={step.alt}
                          width={step.width}
                          height={step.height}
                          loading="lazy"
                          decoding="async"
                          className="h-auto w-full object-contain"
                        />
                      </div>
                      <figcaption className="border-line text-subtle border-b py-3 text-[0.625rem] tracking-[0.15em] uppercase sm:text-xs">
                        {step.caption}
                      </figcaption>
                    </figure>
                  </article>
                </li>
              )
            })}
          </ol>
        </div>
      </Container>
    </section>
  )
}
