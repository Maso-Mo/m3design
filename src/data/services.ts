/**
 * Contenus de la section Services.
 *
 * Les trois intitulés reprennent exclusivement les disciplines déjà établies
 * dans le Hero. Les descriptions restent neutres : elles donnent un cadre
 * éditorial remplaçable sans ajouter de prestation ou de promesse non fournie
 * par le client.
 */
export interface ServiceItem {
  readonly id: 'conception' | 'construction' | 'renovation'
  readonly title: string
  readonly description: string
}

export const servicesIntro = {
  title: 'Du trait à\nl’espace.',
  description:
    'Une lecture architecturale en deux temps : organiser le projet en plan, puis en révéler les volumes et les usages.',
} as const

export const servicesComparison = {
  lightImage: '/images/process/plan-rdc-light.jpg',
  darkImage: '/images/process/plan-rdc-dark.png',
  alt: 'Présentation architecturale associant un plan de rez-de-chaussée en deux dimensions et sa visualisation en volume',
  firstLabel: 'Plan',
  firstDimension: '2D',
  secondLabel: 'Volume',
  secondDimension: '3D',
  caption: 'Lecture comparative — plan et visualisation volumétrique',
} as const

export const services: readonly ServiceItem[] = [
  {
    id: 'conception',
    title: 'Conception',
    description:
      'Les intentions, les usages et les volumes se structurent dans une représentation claire du projet.',
  },
  {
    id: 'construction',
    title: 'Construction',
    description:
      'Le dessin se traduit dans l’espace, en mettant en relation formes, matières et organisation des lieux.',
  },
  {
    id: 'renovation',
    title: 'Rénovation',
    description:
      'L’existant devient le point de départ d’une nouvelle lecture des espaces et de leurs possibilités.',
  },
] as const
