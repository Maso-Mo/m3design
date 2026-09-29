/**
 * Contenus provisoires de la section Garantie.
 *
 * Aucun engagement légal ou contractuel n'est documenté dans le dépôt. Ces
 * textes décrivent donc uniquement des principes généraux de travail. La note
 * associée évite explicitement de les présenter comme une couverture, une
 * assurance ou une durée de garantie.
 */
export interface GuaranteePrinciple {
  readonly id: string
  readonly title: string
  readonly description: string
}

export const guaranteeIntro = {
  title: 'La confiance se construit dans le détail.',
  description:
    'Une ligne de conduite fondée sur l’attention portée aux choix, à leur mise en œuvre et à la clarté des échanges.',
  label: 'Principes de travail',
  notice:
    'Les garanties applicables à chaque projet devront être précisées dans les documents contractuels correspondants.',
} as const

export const guaranteePrinciples: readonly GuaranteePrinciple[] = [
  {
    id: 'qualite',
    title: 'Qualité',
    description:
      'Une attention portée à la cohérence des choix, des matières et des détails d’exécution.',
  },
  {
    id: 'rigueur',
    title: 'Rigueur',
    description:
      'Une organisation structurée pour relier les intentions, les décisions et leur traduction dans le projet.',
  },
  {
    id: 'transparence',
    title: 'Transparence',
    description:
      'Des échanges lisibles pour partager les informations utiles et rendre les choix compréhensibles.',
  },
  {
    id: 'suivi',
    title: 'Suivi',
    description:
      'Une continuité entre le dessin, les décisions prises et l’évolution visible du projet.',
  },
] as const
