import { useLayoutEffect } from 'react'

const REVEAL_SELECTOR = '[data-reveal]'

/**
 * Active une seule observation pour tous les reveals éditoriaux de la page.
 * Les éléments restent visibles sans JavaScript et sont immédiatement révélés
 * lorsque la réduction de mouvement est demandée.
 */
export function useScrollReveal() {
  useLayoutEffect(() => {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR),
    )
    if (elements.length === 0) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let observer: IntersectionObserver | null = null

    const revealEverything = () => {
      observer?.disconnect()
      observer = null
      for (const element of elements) {
        element.classList.add('reveal-ready', 'is-revealed')
      }
    }

    const observe = () => {
      if (
        reducedMotion.matches ||
        typeof IntersectionObserver === 'undefined'
      ) {
        revealEverything()
        return
      }

      observer?.disconnect()
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            entry.target.classList.toggle('is-revealed', entry.isIntersecting)
          }
        },
        { rootMargin: '0px 0px -10% 0px', threshold: 0.08 },
      )

      for (const element of elements) {
        element.classList.add('reveal-ready')
        const bounds = element.getBoundingClientRect()
        if (bounds.top < window.innerHeight * 0.9 && bounds.bottom > 0) {
          element.classList.add('is-revealed')
        }
        observer.observe(element)
      }
    }

    const onPreferenceChange = () => {
      if (reducedMotion.matches) revealEverything()
      else observe()
    }

    observe()
    reducedMotion.addEventListener('change', onPreferenceChange)

    return () => {
      observer?.disconnect()
      reducedMotion.removeEventListener('change', onPreferenceChange)
    }
  }, [])
}
