import { getSection } from '../../data/site'
import { Container } from '../ui/Container'

const section = getSection('a-propos')

const aboutPrinciples = [
  {
    title: 'Observer',
    body: 'Lire un lieu, ses usages et son environnement permet de faire émerger les premières lignes du projet.',
  },
  {
    title: 'Composer',
    body: 'Volumes, lumière, matières et circulations se répondent pour construire un ensemble clair et cohérent.',
  },
  {
    title: 'Donner forme',
    body: "Du premier trait aux détails, l'architecture relie une intention à une manière concrète d'habiter l'espace.",
  },
] as const

/**
 * Section « À propos » — ancre `#a-propos`.
 *
 * La photographie précède le texte dans le DOM : elle arrive donc naturellement
 * en premier sur mobile. À partir de `lg`, les deux colonnes se placent côte à
 * côte et le visuel reste ancré pendant la lecture du manifeste. Les deux
 * variantes d'image sont présentes pour permettre une bascule de thème
 * instantanée, mais une seule est exposée à la fois.
 *
 * Les textes sont volontairement institutionnels et génériques. Ils ne donnent
 * ni chiffre, ni référence, ni promesse et pourront être remplacés directement
 * dans `aboutPrinciples` lorsque les contenus du client seront disponibles.
 */
export function AboutSection() {
  return (
    <section
      id={section.id}
      aria-labelledby="a-propos-titre"
      className="border-line bg-canvas relative z-10 overflow-clip border-t py-20 sm:py-24 lg:py-32"
    >
      <Container size="wide">
        {/* RÉGLAGE DESKTOP IMAGE ↔ TEXTE : réduire `lg:gap-6` / `xl:gap-10`
            rapproche encore les colonnes ; le ratio 1.08 / 0.92 règle leur
            largeur relative sans déplacer les gouttières extérieures. */}
        <div className="grid gap-14 lg:grid-cols-[minmax(0,1.08fr)_minmax(20rem,0.92fr)] lg:items-start lg:gap-6 xl:gap-10">
          <figure className="lg:sticky lg:top-[calc(var(--spacing-header)+2rem)]">
            <div
              data-reveal="image"
              className="bg-surface relative aspect-[4/3] overflow-hidden lg:aspect-[4/5] lg:max-h-[calc(100svh-var(--spacing-header)-7rem)] lg:min-h-[32rem]"
            >
              <img
                src="/images/about/about-light.png"
                alt="Visualisation architecturale d'une maison contemporaine entourée de végétation"
                width={1536}
                height={1024}
                loading="lazy"
                decoding="async"
                className="size-full object-cover object-center dark:hidden"
              />
              <img
                src="/images/about/about-dark.jpg"
                alt="Visualisation architecturale au crépuscule d'une maison contemporaine entourée de végétation"
                width={1080}
                height={720}
                loading="lazy"
                decoding="async"
                className="hidden size-full object-cover object-center dark:block"
              />

              <span
                aria-hidden="true"
                className="absolute top-0 left-0 h-24 w-px bg-brand sm:h-32"
              />
              <span
                aria-hidden="true"
                className="absolute top-0 left-0 h-px w-24 bg-brand sm:w-32"
              />
              <span className="bg-canvas/90 text-strong absolute right-0 bottom-0 px-4 py-3 text-[0.625rem] tracking-[0.2em] uppercase backdrop-blur-sm sm:px-5">
                Architecture résidentielle
              </span>
            </div>

            <figcaption
              data-reveal="up"
              data-reveal-delay="1"
              className="border-line text-subtle mt-4 flex items-center justify-between gap-6 border-t pt-3 text-[0.625rem] tracking-[0.18em] uppercase"
            >
              <span>Image d'étude</span>
              <span aria-hidden="true">01 / 01</span>
            </figcaption>
          </figure>

          <div className="lg:pt-10 xl:pt-16">
            <header data-reveal="up">
              <div className="mb-8 flex items-center gap-4 sm:mb-10">
                <span aria-hidden="true" className="h-px w-10 bg-brand" />
                <p className="text-eyebrow text-accent-ink uppercase">
                  {section.label}
                </p>
              </div>

              <h2
                id="a-propos-titre"
                className="text-display-lg text-strong max-w-[11ch]"
              >
                Penser l'espace,
                <span className="text-accent-ink block italic">
                  révéler l'essentiel.
                </span>
              </h2>

              <p className="text-muted mt-8 max-w-xl text-base leading-8 sm:mt-10 sm:text-lg sm:leading-9">
                L'architecture commence par une attention portée au lieu et à
                celles et ceux qui l'habitent. Chaque choix cherche un équilibre
                entre usage, caractère et simplicité.
              </p>
            </header>

            <ol className="border-line mt-14 border-t sm:mt-16">
              {aboutPrinciples.map((principle, index) => (
                <li
                  key={principle.title}
                  data-reveal="up"
                  data-reveal-delay={String(Math.min(index + 1, 3))}
                  className="border-line grid gap-5 border-b py-8 sm:grid-cols-[3.5rem_1fr] sm:gap-7 sm:py-10"
                >
                  <span className="text-eyebrow text-accent-ink pt-1">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h3 className="text-display-sm text-strong">
                      {principle.title}
                    </h3>
                    <p className="text-muted mt-4 max-w-md text-sm leading-7 sm:text-base sm:leading-8">
                      {principle.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <p
              data-reveal="up"
              className="text-strong mt-12 max-w-md font-display text-2xl leading-snug sm:mt-16 sm:text-3xl"
            >
              Une architecture pensée comme un dialogue entre le lieu, la
              matière et les usages.
            </p>
          </div>
        </div>
      </Container>
    </section>
  )
}
