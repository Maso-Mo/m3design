import { useEffect, useRef, type RefObject } from 'react'
import { DraftingCompass } from 'lucide-react'

const M3_TRAIL_COLOR = '#ff1018'
const COMPASS_SIZE = 34
const MAX_PARTICLES = 84
const MIN_PARTICLE_DISTANCE = 4

type WordmarkZone = 'M3' | 'Design'

type Particle = {
  x: number
  y: number
  velocityX: number
  velocityY: number
  radius: number
  age: number
  lifetime: number
  opacity: number
  color: string
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum)

/**
 * Interaction strictement locale au wordmark : le canvas dessine quelques
 * poussières éphémères, tandis que le compas est déplacé directement dans le
 * DOM. Aucun mouvement de pointeur ne provoque de rendu React.
 */
export function ArchitectCompassTrail({
  targetRef,
}: {
  targetRef: RefObject<HTMLElement | null>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const compassRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const target = targetRef.current
    const canvas = canvasRef.current
    const compass = compassRef.current
    const context = canvas?.getContext('2d')
    if (!target || !canvas || !context) return
    const compassElement = compass
    if (!compassElement) return
    const m3Token = target.querySelector<HTMLElement>('[data-wordmark="M3"]')
    const designToken = target.querySelector<HTMLElement>(
      '[data-wordmark="Design"]',
    )
    if (!m3Token || !designToken) return

    const colorProbe = document.createElement('canvas')
    colorProbe.width = 1
    colorProbe.height = 1
    const colorContext = colorProbe.getContext('2d', {
      willReadFrequently: true,
    })

    const precisePointer = window.matchMedia(
      '(hover: hover) and (pointer: fine)',
    )
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const particles: Particle[] = []
    const initialCursor = target.style.cursor

    let enabled = false
    let active = false
    let animationFrame = 0
    let previousTime = 0
    let targetX = 0
    let targetY = 0
    let renderedX = 0
    let renderedY = 0
    let targetAngle = 0
    let renderedAngle = 0
    let lastPointerX = 0
    let lastPointerY = 0
    let lastEmissionX = 0
    let lastEmissionY = 0
    let canvasWidth = 0
    let canvasHeight = 0
    let pixelRatio = 1
    let activeZone: WordmarkZone | null = null
    let particleColor = M3_TRAIL_COLOR

    const resizeCanvas = () => {
      const bounds = target.getBoundingClientRect()
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      canvasWidth = Math.max(bounds.width, 1)
      canvasHeight = Math.max(bounds.height, 1)
      canvas.width = Math.round(canvasWidth * pixelRatio)
      canvas.height = Math.round(canvasHeight * pixelRatio)
      canvas.style.width = `${canvasWidth}px`
      canvas.style.height = `${canvasHeight}px`
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    }

    const clearCanvas = () => {
      context.clearRect(0, 0, canvasWidth, canvasHeight)
    }

    const requestFrame = () => {
      if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(renderFrame)
      }
    }

    const renderFrame = (time: number) => {
      animationFrame = 0
      const delta = previousTime ? Math.min(time - previousTime, 40) : 16
      previousTime = time

      if (active) {
        renderedX += (targetX - renderedX) * 0.32
        renderedY += (targetY - renderedY) * 0.32
        renderedAngle += (targetAngle - renderedAngle) * 0.24
        compassElement.style.transform = `translate3d(${(renderedX - COMPASS_SIZE / 2).toFixed(2)}px, ${(renderedY - COMPASS_SIZE / 2).toFixed(2)}px, 0) rotate(${renderedAngle.toFixed(2)}deg)`
      }

      clearCanvas()
      context.save()
      context.lineWidth = 0

      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index]
        if (!particle) continue

        particle.age += delta
        if (particle.age >= particle.lifetime) {
          particles.splice(index, 1)
          continue
        }

        const progress = particle.age / particle.lifetime
        particle.x += particle.velocityX * delta
        particle.y += particle.velocityY * delta

        context.beginPath()
        context.globalAlpha = particle.opacity * (1 - progress) * (1 - progress)
        context.fillStyle = particle.color
        context.shadowColor = particle.color
        context.shadowBlur = particle.radius > 1 ? 3.2 : 1.6
        context.arc(
          particle.x,
          particle.y,
          particle.radius * (1 + progress * 0.35),
          0,
          Math.PI * 2,
        )
        context.fill()
      }

      context.restore()

      const compassSettling =
        active &&
        (Math.abs(targetX - renderedX) > 0.08 ||
          Math.abs(targetY - renderedY) > 0.08 ||
          Math.abs(targetAngle - renderedAngle) > 0.08)

      if (particles.length || compassSettling) requestFrame()
    }

    const containsPoint = (bounds: DOMRect, clientX: number, clientY: number) =>
      clientX >= bounds.left &&
      clientX <= bounds.right &&
      clientY >= bounds.top &&
      clientY <= bounds.bottom

    const zoneAtPointer = (event: PointerEvent): WordmarkZone | null => {
      if (
        containsPoint(
          m3Token.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        )
      ) {
        return 'M3'
      }
      if (
        containsPoint(
          designToken.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        )
      ) {
        return 'Design'
      }
      return null
    }

    const opaqueVersionOf = (color: string) => {
      if (!colorContext) return color
      colorContext.clearRect(0, 0, 1, 1)
      colorContext.globalAlpha = 1
      colorContext.fillStyle = color
      colorContext.fillRect(0, 0, 1, 1)
      const [red, green, blue] = colorContext.getImageData(0, 0, 1, 1).data
      return `rgb(${red} ${green} ${blue})`
    }

    const colorsForZone = (zone: WordmarkZone) => {
      if (zone === 'M3') {
        return {
          compass: M3_TRAIL_COLOR,
          particle: M3_TRAIL_COLOR,
        }
      }

      const computedDesignColor = window.getComputedStyle(designToken).color
      return {
        compass: computedDesignColor,
        particle: opaqueVersionOf(computedDesignColor),
      }
    }

    const addParticles = (
      fromX: number,
      fromY: number,
      toX: number,
      toY: number,
      color: string,
    ) => {
      const distance = Math.hypot(toX - fromX, toY - fromY)
      if (distance < MIN_PARTICLE_DISTANCE) return false

      const amount = Math.min(Math.max(Math.ceil(distance / 6), 2), 14)
      for (let index = 0; index < amount; index += 1) {
        if (particles.length >= MAX_PARTICLES) particles.shift()

        const progress = (index + 1) / (amount + 1)
        particles.push({
          x: fromX + (toX - fromX) * progress + (Math.random() - 0.5) * 12,
          y: fromY + (toY - fromY) * progress + (Math.random() - 0.5) * 12,
          velocityX: (Math.random() - 0.5) * 0.012,
          velocityY: -0.004 - Math.random() * 0.012,
          radius: 0.7 + Math.random() * 1.2,
          age: 0,
          lifetime: 400 + Math.random() * 300,
          opacity: 0.32 + Math.random() * 0.22,
          color,
        })
      }
      return true
    }

    const positionFromEvent = (event: PointerEvent) => {
      const bounds = target.getBoundingClientRect()
      return {
        x: clamp(event.clientX - bounds.left, 0, bounds.width),
        y: clamp(event.clientY - bounds.top, 0, bounds.height),
      }
    }

    const deactivateInteraction = () => {
      active = false
      activeZone = null
      targetAngle = 0
      target.style.cursor = initialCursor
      compassElement.style.opacity = '0'
      requestFrame()
    }

    const activateInteraction = (
      zone: WordmarkZone,
      position: { x: number; y: number },
    ) => {
      const colors = colorsForZone(zone)
      active = true
      activeZone = zone
      targetX = position.x
      targetY = position.y
      renderedX = position.x
      renderedY = position.y
      targetAngle = 0
      renderedAngle = 0
      lastPointerX = position.x
      lastPointerY = position.y
      lastEmissionX = position.x
      lastEmissionY = position.y
      particleColor = colors.particle
      target.style.cursor = 'none'
      compassElement.style.color = colors.compass
      compassElement.style.opacity = '1'
      requestFrame()
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!enabled) return
      const zone = zoneAtPointer(event)
      if (!zone) {
        deactivateInteraction()
        return
      }

      const position = positionFromEvent(event)
      if (!active) {
        activateInteraction(zone, position)
        return
      }

      const movementX = position.x - lastPointerX
      const movementY = position.y - lastPointerY

      if (zone !== activeZone) {
        const colors = colorsForZone(zone)
        activeZone = zone
        particleColor = colors.particle
        compassElement.style.color = colors.compass
        lastEmissionX = position.x
        lastEmissionY = position.y
      } else if (
        addParticles(
          lastEmissionX,
          lastEmissionY,
          position.x,
          position.y,
          particleColor,
        )
      ) {
        lastEmissionX = position.x
        lastEmissionY = position.y
      }

      targetX = position.x
      targetY = position.y
      targetAngle = clamp(movementX * 0.7 + movementY * 0.18, -16, 16)
      lastPointerX = position.x
      lastPointerY = position.y
      requestFrame()
    }

    const onPointerEnter = (event: PointerEvent) => onPointerMove(event)
    const onPointerLeave = () => deactivateInteraction()
    const onWindowBlur = () => deactivateInteraction()

    const disable = () => {
      enabled = false
      active = false
      activeZone = null
      particles.length = 0
      target.style.cursor = initialCursor
      compassElement.style.opacity = '0'
      clearCanvas()
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      animationFrame = 0
      previousTime = 0
    }

    const syncCapability = () => {
      if (!precisePointer.matches || reducedMotion.matches) {
        disable()
        return
      }

      enabled = true
      target.style.cursor = initialCursor
    }

    const resizeObserver = new ResizeObserver(resizeCanvas)
    resizeObserver.observe(target)
    resizeCanvas()
    target.addEventListener('pointerenter', onPointerEnter)
    target.addEventListener('pointermove', onPointerMove, { passive: true })
    target.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('blur', onWindowBlur)
    precisePointer.addEventListener('change', syncCapability)
    reducedMotion.addEventListener('change', syncCapability)
    syncCapability()

    return () => {
      disable()
      resizeObserver.disconnect()
      target.removeEventListener('pointerenter', onPointerEnter)
      target.removeEventListener('pointermove', onPointerMove)
      target.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('blur', onWindowBlur)
      precisePointer.removeEventListener('change', syncCapability)
      reducedMotion.removeEventListener('change', syncCapability)
    }
  }, [targetRef])

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20"
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div
        ref={compassRef}
        className="absolute top-0 left-0 opacity-0 transition-[color,opacity] duration-150"
        style={{ width: COMPASS_SIZE, height: COMPASS_SIZE }}
      >
        <DraftingCompass
          aria-hidden="true"
          className="text-canvas/70 absolute inset-0 size-full"
          strokeWidth={2.5}
        />
        <DraftingCompass
          aria-hidden="true"
          className="relative size-full"
          strokeWidth={1.35}
        />
      </div>
    </div>
  )
}
