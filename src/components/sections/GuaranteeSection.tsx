import { guaranteeIntro, guaranteePrinciples } from '../../data/guarantee'
import { getSection } from '../../data/site'
import { Container } from '../ui/Container'

const section = getSection('garantie')

/**
 * Section « Garantie » — ancre `#garantie`.
 *
 * Aucun engagement légal n'étant fourni, la section distingue clairement les
 * principes généraux de travail des garanties contractuelles. Les contenus
 * restent centralisés dans `data/guarantee.ts` pour être remplacés sans toucher
 * à la composition.
 */
export function GuaranteeSection() {
  return (
    <section
      id={section.id}
      aria-labelledby="garantie-titre"
      className="border-line bg-canvas relative overflow-clip border-t py-20 sm:py-24 lg:py-32"
    >
      <span
        aria-hidden="true"
        data-reveal="line-x"
        className="absolute top-0 left-0 h-px w-[clamp(7rem,32vw,32rem)] bg-brand"
      />

      <Container size="wide">
        <header className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.7fr)] lg:items-end lg:gap-20 xl:gap-28">
          <div data-reveal="up">
            <div className="mb-8 flex items-center gap-4 sm:mb-10">
              <span aria-hidden="true" className="h-px w-10 bg-brand" />
              <p className="text-eyebrow text-accent-ink uppercase">
                {section.label}
              </p>
            </div>
            <h2
              id="garantie-titre"
              className="text-display-lg text-strong max-w-[13ch]"
            >
              {guaranteeIntro.title}
            </h2>
          </div>

          <div data-reveal="up" data-reveal-delay="1" className="lg:pb-2">
            <p className="text-muted max-w-xl text-base leading-8 sm:text-lg sm:leading-9">
              {guaranteeIntro.description}
            </p>
            <p className="border-line text-subtle mt-8 border-t pt-5 text-xs leading-6">
              {guaranteeIntro.notice}
            </p>
          </div>
        </header>

        <div className="mt-16 sm:mt-20 lg:mt-28">
          <div className="border-line text-subtle flex items-center justify-between gap-6 border-y py-3 text-[0.625rem] tracking-[0.18em] uppercase sm:text-xs">
            <span>{guaranteeIntro.label}</span>
            <span aria-hidden="true">
              01 — {String(guaranteePrinciples.length).padStart(2, '0')}
            </span>
          </div>

          <ol>
            {guaranteePrinciples.map((principle, index) => (
              <li
                key={principle.id}
                data-reveal="up"
                data-reveal-delay={String(Math.min(index + 1, 3))}
                className="group border-line relative overflow-hidden border-b"
              >
                <span
                  aria-hidden="true"
                  className="bg-accent-soft absolute inset-0 origin-left scale-x-0 transition-transform duration-500 ease-editorial group-hover:scale-x-100 motion-reduce:transition-none"
                />
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 w-px origin-bottom scale-y-0 bg-brand transition-transform duration-300 ease-editorial group-hover:scale-y-100 motion-reduce:transition-none"
                />

                <div className="relative grid grid-cols-[3.5rem_1fr] gap-x-4 gap-y-5 py-8 sm:grid-cols-[5.5rem_minmax(12rem,0.7fr)_minmax(0,1fr)] sm:items-center sm:gap-8 sm:py-10 lg:grid-cols-[7rem_minmax(16rem,0.7fr)_minmax(0,1fr)] lg:py-12">
                  <p className="text-subtle pl-3 font-display text-4xl font-light transition-colors duration-300 ease-editorial group-hover:text-accent-ink motion-reduce:transition-none sm:text-5xl lg:text-6xl">
                    {String(index + 1).padStart(2, '0')}
                  </p>

                  <h3 className="text-strong font-display text-2xl uppercase transition-transform duration-300 ease-editorial group-hover:translate-x-2 motion-reduce:transform-none motion-reduce:transition-none sm:text-3xl lg:text-4xl">
                    {principle.title}
                  </h3>

                  <p className="text-muted col-start-2 max-w-xl text-sm leading-7 transition-[color,transform] duration-300 ease-editorial group-hover:translate-x-2 group-hover:text-strong motion-reduce:transform-none motion-reduce:transition-none sm:col-start-3 sm:text-base sm:leading-8">
                    {principle.description}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Container>
    </section>
  )
}
