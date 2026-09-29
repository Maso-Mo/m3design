import { useEffect, type RefObject } from 'react'

const DESKTOP_BACKGROUND_FACTOR = 0.12
const DESKTOP_WORDMARK_FACTOR = 0.2
const DESKTOP_EDITORIAL_FACTOR = 0.08
const TABLET_BACKGROUND_FACTOR = 0.08
const TABLET_WORDMARK_FACTOR = 0.11
const TABLET_EDITORIAL_FACTOR = 0.05
const MOBILE_BACKGROUND_FACTOR = 0.04
const MOBILE_WORDMARK_FACTOR = 0.05
const MOBILE_EDITORIAL_FACTOR = 0.025

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum)

/**
 * Mouvement du Hero sans rendu React pendant le scroll.
 *
 * Un seul frame est demandé à la fois et uniquement après un scroll, un
 * redimensionnement ou un mouvement de pointeur. L'IntersectionObserver coupe
 * également la matière animée du Wordmark dès que le Hero est loin du viewport.
 */
export function useHeroMotion(
  heroRef: RefObject<HTMLElement | null>,
  wordmarkRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const hero = heroRef.current
    const wordmark = wordmarkRef.current
    if (!hero || !wordmark) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const precisePointer = window.matchMedia(
      '(min-width: 48rem) and (hover: hover) and (pointer: fine)',
    )

    let isNearViewport = false
    let frame = 0
    let pointerX = 0.5
    let pointerY = 0.5

    const resetMotion = () => {
      hero.style.setProperty('--hero-background-y', '0px')
      hero.style.setProperty('--hero-wordmark-y', '0px')
      hero.style.setProperty('--hero-wordmark-pointer-x', '0px')
      hero.style.setProperty('--hero-wordmark-pointer-y', '0px')
      hero.style.setProperty('--hero-pointer-x', '50%')
      hero.style.setProperty('--hero-pointer-y', '50%')
      hero.style.setProperty('--hero-editorial-y', '0px')
      hero.style.setProperty('--hero-wordmark-scale', '1')
      hero.style.setProperty('--hero-wordmark-opacity', '1')
    }

    const renderMotion = () => {
      frame = 0
      if (reducedMotion.matches || !isNearViewport || document.hidden) return

      // Le Hero est le premier contenu du document mais remonte visuellement
      // sous le Header. `scrollY` conserve donc un zéro exact au chargement,
      // contrairement à son `getBoundingClientRect().top` volontairement négatif.
      const travelled = clamp(window.scrollY, 0, hero.offsetHeight)
      const isMobile = window.innerWidth < 768
      const isTablet = window.innerWidth < 1280
      const backgroundFactor = isMobile
        ? MOBILE_BACKGROUND_FACTOR
        : isTablet
          ? TABLET_BACKGROUND_FACTOR
          : DESKTOP_BACKGROUND_FACTOR
      const wordmarkFactor = isMobile
        ? MOBILE_WORDMARK_FACTOR
        : isTablet
          ? TABLET_WORDMARK_FACTOR
          : DESKTOP_WORDMARK_FACTOR
      const editorialFactor = isMobile
        ? MOBILE_EDITORIAL_FACTOR
        : isTablet
          ? TABLET_EDITORIAL_FACTOR
          : DESKTOP_EDITORIAL_FACTOR
      const maximumBackgroundMovement = isMobile ? 24 : isTablet ? 56 : 120
      const maximumWordmarkMovement = isMobile ? 30 : isTablet ? 76 : 160

      hero.style.setProperty(
        '--hero-background-y',
        `${Math.min(travelled * backgroundFactor, maximumBackgroundMovement).toFixed(2)}px`,
      )
      hero.style.setProperty(
        '--hero-wordmark-y',
        `${Math.min(travelled * wordmarkFactor, maximumWordmarkMovement).toFixed(2)}px`,
      )
      hero.style.setProperty(
        '--hero-editorial-y',
        `${Math.min(travelled * editorialFactor, isMobile ? 14 : isTablet ? 34 : 64).toFixed(2)}px`,
      )

      const exitProgress = clamp(
        travelled / Math.max(hero.offsetHeight * 0.7, 1),
        0,
        1,
      )
      hero.style.setProperty(
        '--hero-wordmark-scale',
        (1 + exitProgress * 0.035).toFixed(4),
      )
      hero.style.setProperty(
        '--hero-wordmark-opacity',
        (1 - exitProgress * 0.24).toFixed(3),
      )

      if (precisePointer.matches) {
        hero.style.setProperty('--hero-pointer-x', `${pointerX * 100}%`)
        hero.style.setProperty('--hero-pointer-y', `${pointerY * 100}%`)
        hero.style.setProperty(
          '--hero-wordmark-pointer-x',
          `${((pointerX - 0.5) * 6).toFixed(2)}px`,
        )
        hero.style.setProperty(
          '--hero-wordmark-pointer-y',
          `${((pointerY - 0.5) * 3).toFixed(2)}px`,
        )
      }
    }

    const requestRender = () => {
      if (
        frame ||
        !isNearViewport ||
        reducedMotion.matches ||
        document.hidden
      ) {
        return
      }
      frame = window.requestAnimationFrame(renderMotion)
    }

    const syncActivity = () => {
      const motionActive =
        isNearViewport && !document.hidden && !reducedMotion.matches
      hero.classList.toggle('is-hero-motion-active', motionActive)
      hero.classList.toggle(
        'is-wordmark-motion-active',
        motionActive && precisePointer.matches,
      )

      if (!motionActive) {
        if (frame) window.cancelAnimationFrame(frame)
        frame = 0
        if (reducedMotion.matches) resetMotion()
        return
      }
      requestRender()
    }

    const onScroll = () => requestRender()
    const onResize = () => requestRender()
    const onVisibilityChange = () => syncActivity()
    const onMotionPreferenceChange = () => syncActivity()
    const onPointerCapabilityChange = () => syncActivity()
    const onPointerMove = (event: PointerEvent) => {
      if (!precisePointer.matches) return
      const bounds = wordmark.getBoundingClientRect()
      pointerX = clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
      pointerY = clamp((event.clientY - bounds.top) / bounds.height, 0, 1)
      requestRender()
    }
    const onPointerLeave = () => {
      pointerX = 0.5
      pointerY = 0.5
      requestRender()
    }

    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              isNearViewport = Boolean(entry?.isIntersecting)
              syncActivity()
            },
            { rootMargin: '18% 0px', threshold: 0.01 },
          )

    if (observer) {
      observer.observe(hero)
    } else {
      isNearViewport = true
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    wordmark.addEventListener('pointermove', onPointerMove, { passive: true })
    wordmark.addEventListener('pointerleave', onPointerLeave)
    reducedMotion.addEventListener('change', onMotionPreferenceChange)
    precisePointer.addEventListener('change', onPointerCapabilityChange)
    syncActivity()

    return () => {
      observer?.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      wordmark.removeEventListener('pointermove', onPointerMove)
      wordmark.removeEventListener('pointerleave', onPointerLeave)
      reducedMotion.removeEventListener('change', onMotionPreferenceChange)
      precisePointer.removeEventListener('change', onPointerCapabilityChange)
      hero.classList.remove(
        'is-hero-motion-active',
        'is-wordmark-motion-active',
      )
      resetMotion()
    }
  }, [heroRef, wordmarkRef])
}
