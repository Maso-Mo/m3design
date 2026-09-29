/**
 * Contenus structurants du site : identité, sections, libellés de navigation.
 *
 * Le site public est UNE SEULE page, parcourue par ancres : chaque section
 * déclarée ici existe comme identifiant dans le document (voir
 * `components/sections/` et `pages/HomePage.tsx`). Ajouter, retirer ou
 * réordonner une section, c'est donc modifier cette liste — la navigation, la
 * mise en évidence de la section active et le pied de page suivent.
 *
 * Ce fichier ne contient que des informations DÉJÀ établies (nom de
 * l'entreprise, intitulés des sections). Les contenus rédactionnels et les
 * coordonnées seront fournis à l'étape suivante : rien n'est inventé ici.
 */

export type SectionId =
  | 'accueil'
  | 'a-propos'
  | 'services'
  | 'projets'
  | 'processus'
  | 'garantie'
  | 'contact'

export interface SiteSection {
  readonly id: SectionId
  /** Libellé court : navigation principale, surtitre de section. */
  readonly label: string
  /** Intitulé de la section ; les accroches viendront en dessous. */
  readonly title: string
  /** L'accueil n'a pas de lien : c'est le logo qui y ramène. */
  readonly inNavigation: boolean
  /** Alterne les fonds pour rythmer le défilement de la page. */
  readonly tone?: 'default' | 'surface'
}

export const site = {
  name: 'M3Design',
  /** Le nom se compose en deux temps : « M3 » dans le rouge de la marque, le
      reste dans la couleur du texte. Les deux morceaux servent à la barre de
      navigation ; `name` reste la forme pleine, employée pour l'accessibilité
      et le référencement. */
  nameLead: 'M3',
  nameMark: 'Design',
  /** Discipline de l'entreprise, telle que décrite dans le README du dépôt. */
  discipline: 'Architecture',
  locale: 'fr',
} as const

/**
 * Appels à l'action du site, définis une seule fois : la barre de navigation,
 * le bandeau d'accueil et le pied de page renvoient ainsi au même formulaire,
 * avec le même libellé.
 */
export const actions = {
  /** Action principale : la demande de devis, qui mène au formulaire. */
  quote: { label: 'Demander un devis', href: '#contact' },
  /** Action secondaire : la galerie de réalisations. */
  projects: { label: 'Voir nos réalisations', href: '#realisations-carousel' },
} as const

/**
 * Contenus du bandeau d'accueil (Hero).
 *
 * Ce ne sont pas des contenus inventés : ce sont les textes de la maquette de
 * référence, réunis ici pour que `HeroSection` n'ait plus qu'à les mettre en
 * page — comme le reste des contenus structurants du site.
 */
export const hero = {
  /** Ligne de métiers, en haut du bandeau, séparée par des pastilles rouges. */
  disciplines: ['Conception', 'Construction', 'Rénovation'],
  /** Titre d'accroche : première partie en clair, seconde en rouge. */
  title: {
    lead: "Des idées d'aujourd'hui",
    accent: 'pour des espaces de demain',
  },
  /** Phrase de positionnement, sous le filet rouge. */
  description:
    'Une vision architecturale sur mesure, alliant esthétique, fonctionnalité et durabilité.',
  /** Bloc vertical de droite. Les retours à la ligne sont explicites : ils
      composent la colonne étroite du manifeste, et `whitespace-pre-line` les
      respecte sans gêner la lecture par un lecteur d'écran. */
  statement: "Bâtir aujourd'hui\ndes lieux\nqui ont du sens",
} as const

export const sections: readonly SiteSection[] = [
  { id: 'accueil', label: 'Accueil', title: 'M3Design', inNavigation: false },
  { id: 'a-propos', label: 'À propos', title: 'À propos', inNavigation: true },
  {
    id: 'services',
    label: 'Services',
    title: 'Services',
    inNavigation: true,
    tone: 'surface',
  },
  {
    id: 'projets',
    label: 'Réalisations',
    title: 'Réalisations',
    inNavigation: true,
  },
  {
    id: 'processus',
    label: 'Processus',
    title: 'Processus',
    inNavigation: true,
    tone: 'surface',
  },
  { id: 'garantie', label: 'Garantie', title: 'Garantie', inNavigation: true },
  { id: 'contact', label: 'Contact', title: 'Contact', inNavigation: true },
]

export const navigationSections: readonly SiteSection[] = sections.filter(
  (section) => section.inNavigation,
)

/**
 * Liste d'identifiants stable (construite une fois) : elle sert de dépendance à
 * l'observateur de section active, qui ne doit pas se réinstaller à chaque
 * rendu.
 */
export const sectionIds: readonly string[] = sections.map(
  (section) => section.id,
)

export function getSection(id: SectionId): SiteSection {
  const section = sections.find((candidate) => candidate.id === id)
  if (!section) {
    throw new Error(`Section inconnue : ${id}`)
  }
  return section
}
