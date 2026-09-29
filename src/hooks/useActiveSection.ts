import { useEffect, useState } from 'react'

/**
 * Identifiant de la section actuellement à l'écran, pour souligner le lien de
 * navigation correspondant.
 *
 * Aucune animation ici : un IntersectionObserver surveille les sections, et
 * l'on retient celle dont la proportion visible est la plus grande. La marge
 * de recadrage (`rootMargin`) décale la zone d'observation vers le haut, pour
 * qu'une section soit considérée comme active dès qu'elle occupe le haut de la
 * fenêtre — et non au moment où elle la remplit entièrement.
 *
 * Si l'API n'est pas disponible, rien n'est observé : la navigation reste
 * fonctionnelle, simplement sans lien actif.
 */
export function useActiveSection(ids: readonly string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null)
  // Dépendance stable : la liste est sérialisée pour ne pas relancer
  // l'observateur à chaque rendu.
  const key = ids.join('|')

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return
    }

    const elements = key
      .split('|')
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null)

    if (elements.length === 0) {
      return
    }

    const ratios = new Map<string, number>()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(
            entry.target.id,
            entry.isIntersecting ? entry.intersectionRatio : 0,
          )
        }
        let next: string | null = null
        let best = 0
        for (const [id, ratio] of ratios) {
          if (ratio > best) {
            best = ratio
            next = id
          }
        }
        setActiveId(next)
      },
      { rootMargin: '-30% 0px -55% 0px', threshold: [0, 0.5, 1] },
    )

    for (const element of elements) {
      observer.observe(element)
    }

    return () => observer.disconnect()
  }, [key])

  return activeId
}
