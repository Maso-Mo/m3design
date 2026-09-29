import { ProjectCarousel } from '../projects/ProjectCarousel'
import { projects } from '../../data/projects'
import { getSection } from '../../data/site'
import { Container } from '../ui/Container'

const section = getSection('projets')

/**
 * Section « Projets » — ancre `#projets`.
 *
 * Les visuels sont présentés sans faux titre, lieu, programme ou millésime. Le
 * carrousel et sa lightbox se limitent donc à l'image, à son rang d'affichage
 * et à une description alternative strictement visuelle.
 */
export function ProjectsSection() {
  return (
    <section
      id={section.id}
      aria-labelledby="projets-titre"
      className="border-line bg-canvas relative overflow-clip border-t py-20 sm:py-24 lg:py-32"
    >
      <span
        aria-hidden="true"
        data-reveal="line-x"
        className="absolute top-0 right-0 h-px w-[clamp(5rem,22vw,22rem)] bg-brand"
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
              id="projets-titre"
              className="text-display-lg text-strong max-w-[12ch]"
            >
              Fragments d’architecture.
            </h2>
          </div>

          <p
            data-reveal="up"
            data-reveal-delay="1"
            className="text-muted max-w-lg text-base leading-8 sm:text-lg sm:leading-9 lg:pb-2"
          >
            Une sélection visuelle où le chantier, le dessin et la matière
            racontent différentes étapes de l’architecture.
          </p>
        </header>

        <div id="realisations-carousel" className="mt-14 sm:mt-18 lg:mt-24">
          <ProjectCarousel projects={projects} />
        </div>
      </Container>
    </section>
  )
}
