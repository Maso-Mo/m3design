import {
  services,
  servicesComparison,
  servicesIntro,
} from '../../data/services'
import { getSection } from '../../data/site'
import { Container } from '../ui/Container'

const section = getSection('services')

/**
 * Section « Services » — ancre `#services`.
 *
 * Le grand visuel ne simule pas un comparateur avant/après : les assets source
 * ne sont pas deux vues superposables. Il emploie à la place la composition
 * fournie qui rapproche réellement un plan 2D et sa visualisation 3D, avec une
 * variante dédiée à chaque thème.
 *
 * La liste reprend uniquement les trois disciplines déjà présentes dans le
 * Hero. Titres, descriptions et métadonnées du visuel restent centralisés dans
 * `data/services.ts`.
 */
export function ServicesSection() {
  return (
    <section
      id={section.id}
      aria-labelledby="services-titre"
      className="border-line bg-surface relative overflow-clip border-t py-20 sm:py-24 lg:py-32"
    >
      <span
        aria-hidden="true"
        data-reveal="line-x"
        className="absolute top-0 left-0 h-px w-[clamp(5rem,18vw,18rem)] bg-brand"
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
              id="services-titre"
              className="text-display-lg text-strong max-w-[11ch] whitespace-pre-line"
            >
              {servicesIntro.title}
            </h2>
          </div>

          <p
            data-reveal="up"
            data-reveal-delay="1"
            className="text-muted max-w-xl text-base leading-8 sm:text-lg sm:leading-9 lg:pb-2"
          >
            {servicesIntro.description}
          </p>
        </header>

        <figure data-reveal="image" className="mt-14 sm:mt-18 lg:mt-24">
          <div className="border-line text-subtle flex items-center justify-between gap-6 border-y py-3 text-[0.625rem] tracking-[0.18em] uppercase sm:text-xs">
            <span>Représentation architecturale</span>
            <span aria-hidden="true">2D — 3D</span>
          </div>

          <div className="bg-canvas relative aspect-[3/2] overflow-hidden">
            <img
              src={servicesComparison.lightImage}
              alt={servicesComparison.alt}
              width={1080}
              height={720}
              loading="lazy"
              decoding="async"
              className="size-full object-cover dark:hidden"
            />
            <img
              src={servicesComparison.darkImage}
              alt={servicesComparison.alt}
              width={1536}
              height={1024}
              loading="lazy"
              decoding="async"
              className="hidden size-full object-cover dark:block"
            />

            <span
              aria-hidden="true"
              data-reveal="line-y"
              className="absolute inset-y-0 left-1/2 w-px origin-top bg-brand/80"
            />

            <div className="absolute inset-x-0 bottom-0 grid grid-cols-2">
              <p className="bg-canvas/90 text-strong mr-auto px-4 py-3 text-xs tracking-[0.18em] uppercase backdrop-blur-sm sm:px-6 sm:py-4 sm:text-sm">
                <span className="text-accent-ink mr-2 font-medium">
                  {servicesComparison.firstDimension}
                </span>
                {servicesComparison.firstLabel}
              </p>
              <p className="bg-canvas/90 text-strong ml-auto px-4 py-3 text-xs tracking-[0.18em] uppercase backdrop-blur-sm sm:px-6 sm:py-4 sm:text-sm">
                <span className="text-accent-ink mr-2 font-medium">
                  {servicesComparison.secondDimension}
                </span>
                {servicesComparison.secondLabel}
              </p>
            </div>
          </div>

          <figcaption className="border-line text-subtle flex items-center justify-between gap-6 border-b py-4 text-[0.625rem] tracking-[0.16em] uppercase sm:text-xs">
            <span>{servicesComparison.caption}</span>
            <span aria-hidden="true">01 / 01</span>
          </figcaption>
        </figure>

        <div className="mt-20 grid gap-12 lg:mt-28 lg:grid-cols-[minmax(14rem,0.55fr)_minmax(0,1.45fr)] lg:gap-20 xl:gap-28">
          <header data-reveal="up">
            <p className="text-eyebrow text-accent-ink uppercase">
              Champs d’intervention
            </p>
            <h3 className="text-display-sm text-strong mt-5 max-w-[12ch]">
              Concevoir. Construire. Rénover.
            </h3>
          </header>

          <ol className="border-line border-t">
            {services.map((service, index) => (
              <li
                key={service.id}
                data-reveal="up"
                data-reveal-delay={String(index + 1)}
                className="group border-line relative grid gap-4 border-b py-8 sm:grid-cols-[4.5rem_minmax(10rem,0.7fr)_minmax(0,1fr)] sm:items-start sm:gap-6 sm:py-10"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 w-px origin-bottom scale-y-0 bg-brand transition-transform duration-300 ease-editorial group-hover:scale-y-100 motion-reduce:transition-none"
                />
                <span className="text-subtle pl-3 font-display text-4xl font-light transition-colors duration-300 ease-editorial group-hover:text-accent-ink motion-reduce:transition-none sm:text-5xl">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h4 className="text-strong pl-3 font-display text-2xl uppercase sm:pt-2 sm:pl-0 sm:text-3xl">
                  {service.title}
                </h4>
                <p className="text-muted max-w-lg pl-3 text-sm leading-7 sm:pt-2 sm:pl-0 sm:text-base sm:leading-8">
                  {service.description}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </Container>
    </section>
  )
}
