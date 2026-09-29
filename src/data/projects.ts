/**
 * Images disponibles pour la section Réalisations.
 *
 * Aucun titre, lieu, programme ou millésime n'est déduit des fichiers. Les
 * descriptions alternatives se limitent à ce qui est directement visible et
 * `displayIndex` ne sert qu'à ordonner la galerie.
 */
export interface ProjectImage {
  readonly id: string
  readonly image: string
  readonly alt: string
  readonly displayIndex: number
}

export const projects: readonly ProjectImage[] = [
  {
    id: 'realisation-01',
    image: '/images/projects/1789939010975.jpg',
    alt: 'Travaux d’enduit sur une façade en construction',
    displayIndex: 1,
  },
  {
    id: 'realisation-02',
    image: '/images/projects/1789939015321.jpg',
    alt: 'Travaux de finition sur une façade en construction',
    displayIndex: 2,
  },
  {
    id: 'realisation-03',
    image: '/images/projects/1789939020804.jpg',
    alt: 'Visualisation d’une maison contemporaine entourée d’un jardin',
    displayIndex: 3,
  },
  {
    id: 'realisation-04',
    image: '/images/projects/1789947422688.jpg',
    alt: 'Visualisation architecturale d’une maison blanche dans un environnement arboré',
    displayIndex: 4,
  },
  {
    id: 'realisation-05',
    image: '/images/projects/1789947449006.jpg',
    alt: 'Visualisation verticale d’une maison contemporaine face à une piscine',
    displayIndex: 5,
  },
  {
    id: 'realisation-06',
    image: '/images/projects/1789947459007.jpg',
    alt: 'Visualisation verticale d’une maison contemporaine au bord d’une piscine',
    displayIndex: 6,
  },
  {
    id: 'realisation-07',
    image: '/images/projects/project.jpg',
    alt: 'Visualisation architecturale d’une maison à étage entourée de végétation',
    displayIndex: 7,
  },
] as const
