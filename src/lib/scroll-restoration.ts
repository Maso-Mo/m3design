/**
 * Force uniquement une vraie actualisation du document à repartir du Hero.
 * Les navigations par ancre et l'historique back/forward ne passent pas ici.
 */
export function resetScrollOnReload() {
  const navigation = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined

  if (navigation?.type !== 'reload') return

  const root = document.documentElement
  const previousScrollBehavior = root.style.scrollBehavior

  root.style.scrollBehavior = 'auto'
  history.scrollRestoration = 'manual'

  const forceTop = () => window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  const finish = () => {
    forceTop()
    window.requestAnimationFrame(() => {
      forceTop()
      window.requestAnimationFrame(() => {
        root.style.scrollBehavior = previousScrollBehavior
        // Toujours rendre la main au navigateur pour les traversées
        // back/forward suivantes, même après plusieurs reloads rapprochés.
        history.scrollRestoration = 'auto'
      })
    })
  }

  forceTop()
  window.addEventListener('load', forceTop, { once: true })
  window.addEventListener('pageshow', finish, { once: true })
}
