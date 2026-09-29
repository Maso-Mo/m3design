import { useRef, type CSSProperties } from 'react'
import { ArrowRight, Play } from 'lucide-react'
import { actions, getSection, hero } from '../../data/site'
import { useHeroMotion } from '../../hooks/useHeroMotion'
import { cn } from '../../lib/cn'
import { ButtonLink } from '../ui/Button'
import { Container } from '../ui/Container'

const section = getSection('accueil')

// POSITION HERO : modifier cette valeur pour monter ou descendre les textes du Hero. Une valeur plus négative les fait monter.
const HERO_CONTENT_Y = '-3rem'

// POSITION DISCIPLINES
// Augmenter cette valeur = descendre la ligne.
// Réduire cette valeur = remonter la ligne.
const HERO_DISCIPLINES_Y = '1.25rem'

// POSITION M3DESIGN : modifier cette valeur pour éloigner ou rapprocher le grand titre du Header. Une valeur plus positive le fait descendre.
const HERO_MONUMENT_Y = '1.25rem'

// TAILLE ACCROCHE : modifier cette valeur pour agrandir ou réduire l'accroche sur desktop.
const HERO_HEADLINE_SIZE = 'clamp(3.2rem, 1.3rem + 2.38vw, 3.69rem)'

// LARGEUR ACCROCHE : modifier cette valeur pour élargir ou resserrer l'accroche sur desktop.
const HERO_HEADLINE_WIDTH = '24rem'

// POSITION HORIZONTALE SLOGAN : une valeur plus positive déplace le slogan vers la droite sur desktop.
const HERO_STATEMENT_X = '1.5rem'

// POSITION VERTICALE DU SLOGAN
// valeur plus négative = monte
// valeur moins négative / positive = descend
const HERO_STATEMENT_Y = '-1.75rem'

// LARGEUR SLOGAN : modifier cette valeur pour élargir ou resserrer la colonne du slogan sur desktop.
const HERO_STATEMENT_WIDTH = '7rem'

const statementLines = [
  'BÂTIR',
  "AUJOURD'HUI",
  'DES LIEUX',
  'QUI ONT',
  'DU SENS',
] as const

/**
 * La paire photographique du bandeau : une variante par thème, employée telle
 * quelle. Elle est décorative (`alt=""`) : elle ne porte aucune information, et
 * la décrire reviendrait à inventer un projet. Elle ne comporte AUCUN texte —
 * tout ce qui se lit dans le bandeau est composé en HTML et CSS.
 *
 * La composante horizontale est calée à 52 % sur téléphone, puis à 62 % dès la
 * tablette : le premier cadrage réserve une colonne lisible au texte tout en
 * gardant le visage entier ; le second retrouve la composition panoramique de
 * la maquette. Sur une fenêtre assez large pour montrer l'image entière, ce
 * calage n'a plus d'effet.
 */
function HeroPhoto({ priority = false }: { priority?: boolean }) {
  const shared = {
    width: 1672,
    height: 941,
    decoding: 'async' as const,
    fetchPriority: priority ? ('high' as const) : undefined,
    loading: priority ? undefined : ('lazy' as const),
  }

  return (
    <>
      <img
        {...shared}
        src="/images/hero/hero-light.jpg"
        alt=""
        className="size-full object-cover object-[52%_center] md:object-[62%_center] dark:hidden"
      />
      <img
        {...shared}
        src="/images/hero/hero-dark.jpg"
        alt=""
        className="hidden size-full object-cover object-[52%_center] md:object-[62%_center] dark:block"
      />
    </>
  )
}

function HeroLightReadabilityLayer() {
  const mask =
    'linear-gradient(to right, black 0%, black 48%, rgba(0, 0, 0, 0.85) 52%, rgba(0, 0, 0, 0.35) 58%, transparent 64%)'

  return (
    <img
      aria-hidden="true"
      src="/images/hero/hero-light.jpg"
      alt=""
      width={1672}
      height={941}
      decoding="async"
      className="pointer-events-none absolute inset-0 size-full object-cover object-[52%_center] md:object-[62%_center] dark:hidden"
      style={{
        filter: 'blur(1.2px)',
        maskImage: mask,
        WebkitMaskImage: mask,
      }}
    />
  )
}

function HeroLightDescriptionReadabilityLayer() {
  const mask =
    'radial-gradient(ellipse 218px 79px at calc(50% - 411px) clamp(585px, calc(5vw + 521px), 618px), black 0%, black 65%, rgba(0, 0, 0, 0.85) 78%, rgba(0, 0, 0, 0.35) 90%, transparent 100%)'

  return (
    <img
      aria-hidden="true"
      src="/images/hero/hero-light.jpg"
      alt=""
      width={1672}
      height={941}
      decoding="async"
      className="pointer-events-none absolute inset-0 size-full object-cover object-[52%_center] md:object-[62%_center] dark:hidden"
      style={{
        filter: 'blur(3.2px)',
        maskImage: mask,
        WebkitMaskImage: mask,
      }}
    />
  )
}

function HeroAnimatedPhoto({
  priority = false,
  softenLightBackground = false,
}: {
  priority?: boolean
  softenLightBackground?: boolean
}) {
  return (
    <div className="hero-photo-intro relative size-full">
      <HeroPhoto priority={priority} />
      {softenLightBackground && <HeroLightReadabilityLayer />}
      {softenLightBackground && <HeroLightDescriptionReadabilityLayer />}
      <span
        aria-hidden="true"
        className="hero-intro-veil pointer-events-none absolute inset-0 bg-black"
      />
    </div>
  )
}

/**
 * Les voiles du bandeau, écrits une seule fois et posés deux fois : sous le mot
 * monumental, puis — à l'identique — dans le calque du sujet, qui passe devant
 * lui. Cette reprise exacte est ce qui rend la découpe invisible sur la
 * photographie.
 *
 * En thème clair, aucun voile n'altère les couleurs naturelles de la photo.
 * Les dégradés `canvas` sont réservés au thème sombre et reproduits à
 * l'identique dans le masque du sujet afin que sa découpe reste invisible.
 */
function HeroVeils({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('absolute inset-0', className)}>
      <div className="dark:bg-canvas/10 absolute inset-0" />
      <div className="dark:from-canvas/55 dark:via-canvas/8 absolute inset-0 dark:bg-linear-to-t dark:to-transparent" />
      <div className="dark:from-canvas/45 dark:via-canvas/8 absolute inset-0 dark:bg-linear-to-r dark:to-transparent" />
    </div>
  )
}

/**
 * Bandeau d'accueil (Hero) — ancre `#accueil`.
 *
 * La composition reprend celle de la maquette de référence, dans l'ordre de
 * lecture :
 *
 *  1. la ligne de métiers, centrée juste sous la barre de navigation ;
 *  2. le mot de marque « M3DESIGN », monumental : « M3 » dans le rouge de la
 *     marque, « Design » en fantôme translucide, par-dessus la photographie ;
 *  3. le bloc éditorial, à gauche : le titre (deux lignes claires, deux lignes
 *     rouges), un filet rouge, la phrase de positionnement, puis les deux
 *     appels à l'action ;
 *  4. le manifeste de la marque, calé au bord droit entre deux filets ;
 *  5. un filet de fond ponctué de deux carrés rouges, qui amorce la section
 *     suivante.
 *
 * Trois points de mise en page méritent d'être connus :
 *
 *  - la section REMONTE de la hauteur de la barre de navigation (`-mt-header`)
 *    et la reprend en marge intérieure (`pt-header`). L'image occupe donc le
 *    haut de la fenêtre, DERRIÈRE l'en-tête transparent, comme sur la maquette,
 *    tandis que le contenu commence bien sous la barre ;
 *  - le bandeau ne dépasse pas la hauteur NATURELLE de la photographie à cette
 *    largeur (`min-h-[min(100svh,56.25vw)]`, l'image étant en 16/9). Sur un
 *    écran plus haut que large, la section reste donc `100svh` ; sur un écran
 *    proche du 16/9, elle s'arrête à la photographie : l'image est alors
 *    montrée dans toute sa largeur, sans agrandissement — le sujet y paraît
 *    plus petit, et le décor architectural plus large. Aucun recadrage
 *    arbitraire, aucune déformation, aucun étirement ;
 *  - le SUJET passe devant le mot monumental. C'est le calque découpé : une
 *    copie exacte de la photographie (et de ses voiles), posée au-dessus du
 *    mot, évidée par une ellipse souple centrée sur le visage (propriété
 *    `mask-image`, définie plus bas, à l'endroit où elle sert).
 *    Comme la copie est identique au fond, la découpe est invisible sur
 *    l'image ; elle ne fait disparaître que les lettres qu'elle recouvre. Les
 *    mêmes voiles sont donc peints deux fois (voir `HeroVeils`), sans quoi la
 *    découpe se verrait en creux sur la photographie.
 *
 * Les voiles `canvas` sont réservés au thème sombre. En thème clair, la photo
 * conserve ses couleurs et son contraste naturels. Le rouge décoratif vient
 * de `brand`, tandis que le rouge employé comme texte utilise `accent-ink` sur
 * le thème clair pour conserver un contraste suffisant.
 *
 * Accessibilité : le mot monumental est décoratif pour les technologies
 * d'assistance — le nom est déjà porté en toutes lettres par l'en-tête et le
 * pied de page —, tandis que le titre de la page reste le `h1`, relié à la
 * section par `aria-labelledby`.
 */
export function HeroSection() {
  const heroRef = useRef<HTMLElement>(null)
  const wordmarkRef = useRef<HTMLDivElement>(null)
  useHeroMotion(heroRef, wordmarkRef)

  return (
    <section
      ref={heroRef}
      id={section.id}
      aria-labelledby="accueil-titre"
      className={cn(
        'pt-header -mt-header relative isolate flex flex-col',
        'min-h-[min(100svh,56.25vw)] bg-canvas overflow-hidden',
      )}
    >
      {/* Le fond du bandeau : la photographie, puis ses voiles, posés juste
          derrière le mot monumental. Le sujet, lui, repasse devant ce mot (voir
          le calque découpé, à la fin de la section). */}
      <div
        aria-hidden="true"
        className="hero-parallax-layer absolute inset-0 -z-20"
      >
        <HeroAnimatedPhoto priority softenLightBackground />
      </div>
      <HeroVeils className="-z-10" />
      <span
        aria-hidden="true"
        className="hero-mobile-contrast pointer-events-none absolute inset-y-0 left-0 -z-[5] w-[78%] md:hidden dark:hidden"
      />

      <Container className="relative flex flex-1 flex-col">
        <div
          style={
            {
              '--hero-content-y': HERO_CONTENT_Y,
              '--hero-disciplines-y': HERO_DISCIPLINES_Y,
              '--hero-monument-y': HERO_MONUMENT_Y,
              '--hero-headline-size': HERO_HEADLINE_SIZE,
              '--hero-headline-width': HERO_HEADLINE_WIDTH,
              '--hero-statement-x': HERO_STATEMENT_X,
              '--hero-statement-y': HERO_STATEMENT_Y,
              '--hero-statement-width': HERO_STATEMENT_WIDTH,
            } as CSSProperties
          }
          className="relative xl:top-[var(--hero-content-y)]"
        >
          {/* 1. Les métiers, dans l'ordre de la maquette. La liste est sémantique
              (trois éléments), et la pastille rouge qui les sépare est un
              pseudo-élément : elle n'est donc jamais lue par un lecteur d'écran. */}
          <ul className="hero-editorial-motion hero-intro-block hero-intro-disciplines text-eyebrow relative z-20 flex flex-wrap items-center justify-start gap-x-3 gap-y-2 pt-6 text-[#242424] uppercase sm:pt-8 xl:top-[var(--hero-disciplines-y)] xl:pt-5 dark:text-muted">
            {hero.disciplines.map((discipline, index) => (
              <li
                key={discipline}
                className={cn(
                  'flex items-center gap-3',
                  index > 0 &&
                  "before:bg-brand before:size-1 before:rounded-full before:content-['']",
                )}
              >
                {discipline}
              </li>
            ))}
          </ul>

          {/* 2. Le mot de marque. Il est décoratif : le nom est déjà porté, en
            toutes lettres, par l'en-tête et le pied de page. Sa taille est
            exprimée en `cqw` — l'unité de largeur du BLOC, et non de la
            fenêtre : le mot occupe donc toujours la même part de la colonne,
            du téléphone au très grand écran, sans jamais en sortir. « Design »
            est volontairement très effacé : posé sur la photographie, il doit
            se fondre dans la composition, et non la recouvrir. */}
          <div
            ref={wordmarkRef}
            className="@container relative mt-2 sm:mt-3 xl:top-[var(--hero-monument-y)]"
          >
            <p
              aria-hidden="true"
              className="hero-wordmark-motion text-[18cqw] font-sans leading-[0.82] font-black tracking-[-0.045em] uppercase xl:text-[16.9cqw]"
            >
              <span
                data-wordmark="M3"
                className="hero-wordmark-token hero-wordmark-m3 hero-wordmark-intro-m3 text-brand"
              >
                M3
              </span>
              <span
                data-wordmark="Design"
                className="hero-wordmark-token hero-wordmark-design hero-wordmark-intro-design text-strong/20"
              >
                Design
              </span>
            </p>
          </div>

          {/* 3 et 4. Le bloc éditorial et le manifeste : sur la même ligne en
            grand écran, empilés dans l'ordre de lecture en dessous. */}
          <div className="hero-editorial-motion relative z-20 mt-6 grid gap-10 lg:mt-7 lg:grid-cols-12 lg:gap-6 xl:mt-9">
            <div className="relative flex flex-col items-start gap-6 lg:col-span-6 lg:gap-5 xl:col-span-7">
              {/* Sous `xl`, la photographie se montre entière et le bloc
                éditorial — de largeur fixe — tombe alors sur la partie sombre
                de l'image, la chemise du sujet : le rouge du titre et le gris
                de la phrase de positionnement s'y perdent. Un voile de
                `canvas`, débordant et fondu par le flou, éclaircit donc le
                fond DERRIÈRE le texte : rien n'est découpé, aucun bord ne se
                voit, et la photographie reste intacte partout ailleurs. Dès
                que la mise en page à deux colonnes ramène le texte sur la
                partie claire de l'image (`xl`), le voile s'efface. */}
              <span
                aria-hidden="true"
                className="bg-canvas/12 dark:bg-canvas/30 pointer-events-none absolute -top-8 -bottom-8 -left-6 -z-10 w-[34rem] max-w-[60vw] blur-2xl xl:hidden"
              />
              <h1
                id="accueil-titre"
                className="hero-intro-block hero-intro-headline max-w-[16.5rem] text-[clamp(1.6875rem,1.15rem+2.1vw,3.25rem)] leading-[1.06] tracking-[-0.02em] text-[#080808] [text-shadow:0_1px_1px_rgb(255_255_255_/_0.80),0_0_7px_rgb(255_255_255_/_0.32)] md:max-w-[22rem] lg:max-w-[20rem] xl:max-w-[var(--hero-headline-width)] xl:text-[length:var(--hero-headline-size)] dark:text-strong dark:[text-shadow:none]"
              >
                <span className="block">{hero.title.lead}</span>
                <span className="block text-[#B20A10] [text-shadow:0_1px_1px_rgb(255_255_255_/_0.70),0_0_6px_rgb(255_255_255_/_0.34)] dark:text-brand dark:[text-shadow:none]">
                  {hero.title.accent}
                </span>
              </h1>

              <span
                aria-hidden="true"
                className="hero-intro-line hero-intro-rule h-px w-24 bg-brand"
              />

              <p className="hero-description-panel hero-intro-block hero-intro-description max-w-[16.5rem] text-[#101010] [text-shadow:0_1px_1px_rgb(255_255_255_/_0.90),0_0_5px_rgb(255_255_255_/_0.55)] md:max-w-[26rem] dark:text-strong/80 dark:[text-shadow:none]">
                {hero.description}
              </p>

              <div className="hero-intro-block hero-intro-actions mt-2 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-4">
                <ButtonLink href={actions.quote.href}>
                  {actions.quote.label}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </ButtonLink>

                {/* Action secondaire : le fond translucide, pris sur `canvas`,
                  garde le libellé lisible quelle que soit la photographie
                  qu'il recouvre. */}
                <ButtonLink
                  variant="outline"
                  href={actions.projects.href}
                  className="bg-canvas/40 backdrop-blur-sm"
                >
                  {actions.projects.label}
                  <span className="bg-canvas/60 flex size-6 items-center justify-center rounded-full">
                    <Play
                      className="size-2.5 fill-current"
                      aria-hidden="true"
                    />
                  </span>
                </ButtonLink>
              </div>
            </div>

            {/* Le manifeste : une colonne étroite, alignée au bord droit, entre
              deux filets de la largeur du texte. Chaque ligne est explicite
              pour garantir la composition, quelle que soit la largeur. */}
            <div className="hero-intro-block hero-intro-slogan hero-statement flex w-full flex-col items-end gap-3 lg:col-span-6 lg:col-start-7 xl:relative xl:top-[var(--hero-statement-y)] xl:left-[var(--hero-statement-x)] xl:col-span-5 xl:col-start-8">
              <span
                aria-hidden="true"
                className="bg-strong/20 max-md:bg-strong/35 h-px w-full max-w-[11rem] dark:bg-white/25 xl:max-w-[var(--hero-statement-width)]"
              />
              <p
                aria-label={statementLines.join(' ')}
                className="max-w-[11rem] text-right text-[clamp(0.78rem,0.70rem+0.15vw,0.92rem)] leading-[1.12] font-semibold tracking-[0.14em] text-[#111111] uppercase dark:text-white xl:w-[var(--hero-statement-width)]"
              >
                <span
                  aria-hidden="true"
                  className="flex flex-col items-end xl:items-start"
                >
                  {statementLines.map((line) => (
                    <span key={line} className="block whitespace-nowrap">
                      {line}
                    </span>
                  ))}
                </span>
              </p>
              <span
                aria-hidden="true"
                className="bg-strong/20 max-md:bg-strong/35 h-px w-full max-w-[11rem] dark:bg-white/25 xl:max-w-[var(--hero-statement-width)]"
              />
            </div>
          </div>
        </div>

        {/* 5. Le filet de fond et ses deux carrés rouges : ils ferment le
            bandeau et annoncent la section suivante. */}
        <div
          aria-hidden="true"
          className="hero-intro-line hero-intro-closing mt-auto flex items-center gap-4 pt-12 pb-6 lg:pt-16"
        >
          <span className="bg-brand size-1.5" />
          <span className="bg-line h-px flex-1" />
          <span className="bg-brand size-1.5" />
        </div>
      </Container>

      {/* Le SUJET repasse devant le mot monumental : une seconde copie EXACTE de
          la photographie — mêmes images, mêmes voiles, mêmes calages — posée
          au-dessus du contenu, puis évidée par une ellipse souple centrée sur
          le visage (`mask-image`, en fin de section). Comme la copie est
          identique à ce qui est déjà peint dessous, la découpe ne se voit pas
          sur l'image : elle ne retire que les lettres qu'elle recouvre, et le
          visage reste entier, comme sur la maquette.

          Les bornes de l'ellipse sont choisies pour ne toucher AUCUN texte : le
          cœur opaque (60 % du rayon) couvre la tête et les épaules, et la
          transition s'éteint avant le manifeste, à droite, comme avant la ligne
          des métiers, au-dessus.

          Le calque est inerte (`pointer-events-none`). Son masque suit le
          cadrage : resserré à droite sur téléphone, où le sujet libère la
          colonne de texte, puis recentré sur le visage dès la tablette. */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 z-10',
          '[mask-image:radial-gradient(ellipse_22%_20%_at_88%_28%,#000_0_64%,transparent_94%)]',
          '[-webkit-mask-image:radial-gradient(ellipse_22%_20%_at_88%_28%,#000_0_64%,transparent_94%)]',
          'md:[mask-image:radial-gradient(ellipse_15%_23%_at_61%_32%,#000_0_64%,transparent_94%)]',
          'md:[-webkit-mask-image:radial-gradient(ellipse_15%_23%_at_61%_32%,#000_0_64%,transparent_94%)]',
        )}
      >
        <div className="hero-parallax-layer absolute inset-0">
          <HeroAnimatedPhoto />
        </div>
        <HeroVeils />
      </div>
    </section>
  )
}
