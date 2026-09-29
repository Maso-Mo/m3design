/**
 * Contenus neutres de la section Processus.
 *
 * Les quatre visuels montrent une même façade sous deux formes — photographie
 * et dessin — et dans deux états d'avancement. Les intitulés décrivent cette
 * lecture visuelle sans imposer un processus commercial ou administratif qui
 * n'a pas encore été fourni par le client.
 */
export interface ProcessStep {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly image: string
  readonly alt: string
  readonly caption: string
  readonly width: number
  readonly height: number
}

export const processIntro = {
  title: 'Du regard\nà la matière.',
  description:
    'Une progression visuelle qui met en relation l’état observé, le dessin et l’évolution du bâti.',
} as const

export const processSteps: readonly ProcessStep[] = [
  {
    id: 'observer',
    title: 'Observer',
    description:
      'L’état visible constitue un point de départ pour lire les volumes, les matières et les transformations en cours.',
    image: '/images/process/01_avant_photo.png',
    alt: 'Façade en construction pendant la pose d’un premier état d’enduit',
    caption: 'État photographié — avant progression',
    width: 323,
    height: 199,
  },
  {
    id: 'interpreter',
    title: 'Interpréter',
    description:
      'Le dessin reprend la façade observée et en clarifie les lignes, les ouvertures et les proportions.',
    image: '/images/process/03_avant_dessin.png',
    alt: 'Dessin monochrome de la façade dans son état initial de construction',
    caption: 'Lecture dessinée — état initial',
    width: 323,
    height: 167,
  },
  {
    id: 'projeter',
    title: 'Projeter',
    description:
      'Une seconde représentation donne à voir une évolution possible de la même composition architecturale.',
    image: '/images/process/04_apres_dessin.png',
    alt: 'Dessin de la même façade dans un état architectural plus avancé',
    caption: 'Lecture dessinée — état avancé',
    width: 343,
    height: 167,
  },
  {
    id: 'transformer',
    title: 'Faire évoluer',
    description:
      'La photographie suivante montre la progression visible du bâti et met en regard dessin et réalisation.',
    image: '/images/process/02_apres_photo.png',
    alt: 'Même façade en construction avec l’enduit dans un état plus avancé',
    caption: 'État photographié — après progression',
    width: 343,
    height: 199,
  },
] as const
