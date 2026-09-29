import type { ContactFormValues, ContactMode } from './contact-form'

export type ContactSubmission = {
  reference: string
  status: string
  replayed: boolean
  notificationQueued: boolean
  phoneMasked: string | null
  submittedAt: number
}

type ApiErrorBody = {
  error?: {
    code?: unknown
    retryAfterSeconds?: unknown
  }
}

export class ContactSubmissionError extends Error {
  readonly code: string
  readonly status: number | null
  readonly retryAfterSeconds: number | null

  constructor(
    code: string,
    status: number | null,
    retryAfterSeconds: number | null = null,
  ) {
    super(code)
    this.name = 'ContactSubmissionError'
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type SubmitOptions = {
  idempotencyKey: string
  turnstileToken?: string
  fetchImplementation?: typeof fetch
  apiBaseUrl?: string
}

function buildEndpoint(mode: ContactMode, apiBaseUrl: string): string {
  const base = apiBaseUrl.trim().replace(/\/$/, '')
  return `${base}/api/${mode}`
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function isSubmission(value: unknown): value is ContactSubmission {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ContactSubmission>
  return (
    typeof candidate.reference === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.replayed === 'boolean' &&
    typeof candidate.notificationQueued === 'boolean' &&
    (typeof candidate.phoneMasked === 'string' ||
      candidate.phoneMasked === null) &&
    typeof candidate.submittedAt === 'number'
  )
}

/** Envoie les noms de propriétés exacts attendus par les deux routes du Worker. */
export async function submitContactForm(
  mode: ContactMode,
  values: ContactFormValues,
  options: SubmitOptions,
): Promise<ContactSubmission> {
  const body: Record<string, string> = {
    name: values.name.trim(),
    email: values.email.trim(),
    idempotencyKey: options.idempotencyKey,
    website: values.website,
    [mode === 'devis' ? 'description' : 'message']: values.content.trim(),
  }

  if (values.phone.trim() !== '') body.phone = values.phone.trim()
  if (options.turnstileToken) {
    body.turnstileToken = options.turnstileToken
  }

  let response: Response
  try {
    response = await (options.fetchImplementation ?? fetch)(
      buildEndpoint(
        mode,
        options.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? '',
      ),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
  } catch {
    throw new ContactSubmissionError('network_error', null)
  }

  const responseBody = await readJson(response)
  if (response.ok) {
    if (!isSubmission(responseBody)) {
      throw new ContactSubmissionError('invalid_response', response.status)
    }
    return responseBody
  }

  const apiError = responseBody as ApiErrorBody | null
  const code =
    typeof apiError?.error?.code === 'string'
      ? apiError.error.code
      : 'unexpected_error'
  const retryAfterSeconds =
    positiveInteger(response.headers.get('Retry-After')) ??
    positiveInteger(apiError?.error?.retryAfterSeconds)

  throw new ContactSubmissionError(code, response.status, retryAfterSeconds)
}

function retryDelayLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} secondes`
  if (seconds < 3600) {
    const minutes = Math.ceil(seconds / 60)
    return `${minutes} minute${minutes > 1 ? 's' : ''}`
  }
  const hours = Math.ceil(seconds / 3600)
  return `${hours} heure${hours > 1 ? 's' : ''}`
}

/** Traduit uniquement les codes stables ; les détails serveur ne sont jamais exposés. */
export function contactErrorMessage(error: unknown): string {
  if (!(error instanceof ContactSubmissionError)) {
    return 'Une erreur inattendue est survenue. Réessayez dans un moment.'
  }

  if (error.code === 'challenge_failed') {
    return 'La vérification anti-robot a échoué. Relancez-la puis réessayez.'
  }
  if (error.code === 'request_rejected' || error.status === 409) {
    return 'Une demande est déjà enregistrée pour ce numéro de téléphone.'
  }
  if (error.code === 'too_many_requests' || error.status === 429) {
    return error.retryAfterSeconds
      ? `Trop de demandes ont été envoyées. Réessayez dans environ ${retryDelayLabel(error.retryAfterSeconds)}.`
      : 'Trop de demandes ont été envoyées. Réessayez plus tard.'
  }
  if (error.code === 'service_unavailable' || error.status === 503) {
    return 'Le service est momentanément indisponible. Réessayez dans un moment.'
  }
  if (error.code === 'invalid_request' || error.status === 400) {
    return 'La demande n’a pas pu être validée. Vérifiez les informations saisies.'
  }
  if (error.code === 'network_error') {
    return 'La connexion au service a échoué. Vérifiez votre réseau puis réessayez.'
  }

  return 'L’envoi n’a pas abouti. Réessayez dans un moment.'
}
