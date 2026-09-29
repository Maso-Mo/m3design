import { useEffect, useRef } from 'react'

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string
      theme: 'auto'
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
    },
  ) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_ID = 'cloudflare-turnstile-script'
let turnstileLoader: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (turnstileLoader) return turnstileLoader

  const loader = new Promise<TurnstileApi>((resolve, reject) => {
    const resolveApi = () => {
      if (window.turnstile) resolve(window.turnstile)
      else reject(new Error('Turnstile indisponible'))
    }
    const rejectApi = () => reject(new Error('Chargement Turnstile impossible'))
    const existing = document.getElementById(
      SCRIPT_ID,
    ) as HTMLScriptElement | null

    if (existing) {
      existing.addEventListener('load', resolveApi, { once: true })
      existing.addEventListener('error', rejectApi, { once: true })
      return
    }

    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src =
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.addEventListener('load', resolveApi, { once: true })
    script.addEventListener('error', rejectApi, { once: true })
    document.head.append(script)
  }).catch((error: unknown) => {
    turnstileLoader = null
    throw error
  })

  turnstileLoader = loader
  return loader
}

type TurnstileWidgetProps = {
  siteKey: string
  resetSignal: number
  onToken: (token: string | null) => void
  onUnavailable: () => void
}

export function TurnstileWidget({
  siteKey,
  resetSignal,
  onToken,
  onUnavailable,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const callbacksRef = useRef({ onToken, onUnavailable })

  useEffect(() => {
    callbacksRef.current = { onToken, onUnavailable }
  }, [onToken, onUnavailable])

  useEffect(() => {
    let active = true

    void loadTurnstile()
      .then((turnstile) => {
        if (!active || !containerRef.current) return
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: 'auto',
          callback: (token) => callbacksRef.current.onToken(token),
          'expired-callback': () => callbacksRef.current.onToken(null),
          'error-callback': () => {
            callbacksRef.current.onToken(null)
            callbacksRef.current.onUnavailable()
          },
        })
      })
      .catch(() => {
        if (active) callbacksRef.current.onUnavailable()
      })

    return () => {
      active = false
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
      }
      widgetIdRef.current = null
    }
  }, [siteKey])

  useEffect(() => {
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current)
      callbacksRef.current.onToken(null)
    }
  }, [resetSignal])

  return (
    <div
      id="contact-turnstile"
      ref={containerRef}
      tabIndex={-1}
      aria-label="Vérification anti-robot"
      className="min-h-[65px]"
    />
  )
}
