import { type ChangeEvent, type FormEvent, useRef, useState } from 'react'
import { ArrowRight, Check, LoaderCircle } from 'lucide-react'
import { getSection } from '../../data/site'
import {
  contactErrorMessage,
  submitContactForm,
  type ContactSubmission,
} from '../../lib/contact-api'
import {
  CONTACT_MODES,
  createIdempotencyKey,
  EMPTY_CONTACT_FORM,
  type ContactField,
  type ContactFieldErrors,
  type ContactFormValues,
  type ContactMode,
  validateContactForm,
} from '../../lib/contact-form'
import { cn } from '../../lib/cn'
import { TurnstileWidget } from '../contact/TurnstileWidget'
import { Container } from '../ui/Container'

const section = getSection('contact')
const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? ''

type FormPhase = 'idle' | 'submitting' | 'success' | 'error'

const fieldBase =
  'contact-field border-line-strong bg-elevated text-strong placeholder:text-subtle mt-3 min-h-13 w-full rounded-[2px] border px-4 py-3 text-base outline-none transition-[border-color,box-shadow] duration-200 hover:border-strong focus:border-accent-ink focus:ring-1 focus:ring-accent-ink/20 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ink disabled:cursor-not-allowed disabled:opacity-60'

export function ContactSection() {
  const [mode, setMode] = useState<ContactMode>('devis')
  const [values, setValues] = useState<ContactFormValues>(EMPTY_CONTACT_FORM)
  const [errors, setErrors] = useState<ContactFieldErrors>({})
  const [phase, setPhase] = useState<FormPhase>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [submission, setSubmission] = useState<ContactSubmission | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileReset, setTurnstileReset] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)
  const submittingRef = useRef(false)
  const idempotencyKeyRef = useRef(createIdempotencyKey())
  const copy = CONTACT_MODES[mode]

  const focusField = (field: ContactField) => {
    if (field === 'turnstile') {
      document.getElementById('contact-turnstile')?.focus()
      return
    }
    const control = formRef.current?.elements.namedItem(field)
    if (control instanceof HTMLElement) control.focus()
  }

  const updateField = (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const field = event.target.name as keyof ContactFormValues
    setValues((current) => ({ ...current, [field]: event.target.value }))
    if (field === 'name' || field === 'email' || field === 'content') {
      setErrors((current) => ({ ...current, [field]: undefined }))
    }
    if (phase === 'error') {
      setPhase('idle')
      setStatusMessage('')
    }
  }

  const selectMode = (nextMode: ContactMode) => {
    if (nextMode === mode || submittingRef.current) return
    setMode(nextMode)
    setErrors({})
    setPhase('idle')
    setStatusMessage('')
    setSubmission(null)
    setTurnstileToken(null)
    setTurnstileReset((value) => value + 1)
    idempotencyKeyRef.current = createIdempotencyKey()
  }

  const resetForm = () => {
    setValues(EMPTY_CONTACT_FORM)
    setErrors({})
    setPhase('idle')
    setStatusMessage('')
    setSubmission(null)
    setTurnstileToken(null)
    setTurnstileReset((value) => value + 1)
    idempotencyKeyRef.current = createIdempotencyKey()
    window.requestAnimationFrame(() => focusField('name'))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submittingRef.current) return

    const nextErrors = validateContactForm(values)
    if (turnstileSiteKey && !turnstileToken) {
      nextErrors.turnstile = 'Effectuez la vérification anti-robot.'
    }

    const firstInvalid = (
      ['name', 'email', 'content', 'turnstile'] as const
    ).find((field) => nextErrors[field])
    if (firstInvalid) {
      setErrors(nextErrors)
      setPhase('error')
      setStatusMessage('Certains champs doivent être vérifiés.')
      window.requestAnimationFrame(() => focusField(firstInvalid))
      return
    }

    submittingRef.current = true
    setErrors({})
    setPhase('submitting')
    setStatusMessage('Envoi en cours…')

    try {
      const result = await submitContactForm(mode, values, {
        idempotencyKey: idempotencyKeyRef.current,
        ...(turnstileToken ? { turnstileToken } : {}),
      })
      setSubmission(result)
      setPhase('success')
      setStatusMessage(
        result.replayed
          ? 'Votre demande avait déjà été reçue.'
          : 'Votre demande a bien été transmise.',
      )
    } catch (error) {
      setPhase('error')
      setStatusMessage(contactErrorMessage(error))
      if (turnstileSiteKey) {
        setTurnstileToken(null)
        setTurnstileReset((value) => value + 1)
      }
    } finally {
      submittingRef.current = false
    }
  }

  return (
    <section
      id={section.id}
      aria-labelledby="contact-titre"
      className="border-line bg-surface relative overflow-hidden border-t py-20 sm:py-24 lg:py-32"
    >
      <span
        aria-hidden="true"
        data-reveal="line-x"
        className="absolute top-0 right-0 h-px w-[clamp(8rem,42vw,42rem)] origin-right bg-brand"
      />

      <Container size="wide">
        <div className="grid gap-14 lg:grid-cols-[minmax(17rem,0.72fr)_minmax(32rem,1fr)] lg:gap-20 xl:gap-28">
          <header
            data-reveal="up"
            className="lg:sticky lg:top-32 lg:self-start"
          >
            <div className="mb-8 flex items-center gap-4">
              <span aria-hidden="true" className="h-px w-10 bg-brand" />
              <p className="text-eyebrow text-accent-ink uppercase">
                {section.label}
              </p>
            </div>
            <h2
              id="contact-titre"
              className="text-display-lg text-strong max-w-[11ch]"
            >
              Donnons une forme à vos idées.
            </h2>
            <p className="text-muted mt-8 max-w-md text-base leading-8 sm:text-lg sm:leading-9">
              Parlez-nous de votre projet ou laissez-nous un message. Quelques
              lignes suffisent pour amorcer l’échange.
            </p>
            <p className="border-line text-subtle mt-10 max-w-md border-t pt-5 text-xs leading-6">
              Les informations saisies sont utilisées pour traiter votre
              demande.
            </p>
          </header>

          <div
            data-reveal="up"
            data-reveal-delay="1"
            className="border-line border-t lg:mt-2"
          >
            <fieldset
              className="border-line grid grid-cols-2 border-b"
              disabled={phase === 'submitting'}
            >
              <legend className="sr-only">Type de demande</legend>
              {(['devis', 'contact'] as const).map((candidate) => {
                const selected = candidate === mode
                return (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectMode(candidate)}
                    className={cn(
                      'relative min-h-16 px-3 text-center text-[0.6875rem] font-medium tracking-[0.16em] uppercase transition-colors sm:px-6 sm:text-xs',
                      candidate === 'contact' && 'border-line border-l',
                      selected
                        ? 'bg-strong text-canvas'
                        : 'text-muted hover:bg-elevated hover:text-strong',
                    )}
                  >
                    {CONTACT_MODES[candidate].label}
                    {selected ? (
                      <span
                        aria-hidden="true"
                        className="absolute right-0 bottom-0 left-0 h-0.5 bg-brand"
                      />
                    ) : null}
                  </button>
                )
              })}
            </fieldset>

            {phase === 'success' && submission ? (
              <div
                className="state-enter flex min-h-[32rem] flex-col justify-center py-14 sm:py-20"
                role="status"
                aria-live="polite"
              >
                <span className="bg-accent text-accent-contrast mb-8 flex size-11 items-center justify-center rounded-full">
                  <Check aria-hidden="true" size={20} strokeWidth={1.8} />
                </span>
                <p className="text-eyebrow text-accent-ink uppercase">
                  Demande reçue
                </p>
                <h3 className="text-strong mt-5 max-w-lg font-display text-3xl leading-tight sm:text-4xl">
                  Merci. Nous avons bien reçu votre{' '}
                  {mode === 'devis' ? 'demande' : 'message'}.
                </h3>
                <p className="text-muted mt-6 text-sm leading-7">
                  Référence publique
                  <strong className="text-strong ml-3 font-mono font-medium tracking-wide">
                    {submission.reference}
                  </strong>
                </p>
                <button
                  type="button"
                  onClick={resetForm}
                  className="border-line-strong text-strong hover:border-strong hover:bg-elevated mt-10 inline-flex min-h-12 w-fit items-center gap-3 border px-6 text-sm font-medium transition-colors"
                >
                  Commencer une nouvelle demande
                  <ArrowRight aria-hidden="true" size={17} />
                </button>
              </div>
            ) : (
              <form
                ref={formRef}
                noValidate
                onSubmit={handleSubmit}
                className="py-10 sm:py-12"
              >
                <div className="grid gap-x-8 gap-y-8 sm:grid-cols-2 sm:gap-y-10">
                  <div>
                    <label
                      htmlFor="contact-name"
                      className="text-strong text-xs font-medium tracking-[0.12em] uppercase"
                    >
                      Nom <span className="text-accent-ink">*</span>
                    </label>
                    <input
                      id="contact-name"
                      name="name"
                      type="text"
                      autoComplete="name"
                      required
                      maxLength={120}
                      value={values.name}
                      onChange={updateField}
                      disabled={phase === 'submitting'}
                      aria-invalid={Boolean(errors.name)}
                      aria-describedby={
                        errors.name ? 'contact-name-error' : undefined
                      }
                      className={cn(
                        fieldBase,
                        errors.name && 'border-accent-ink',
                      )}
                    />
                    {errors.name ? (
                      <p
                        id="contact-name-error"
                        className="text-accent-ink mt-2 text-xs"
                      >
                        {errors.name}
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <label
                      htmlFor="contact-email"
                      className="text-strong text-xs font-medium tracking-[0.12em] uppercase"
                    >
                      Adresse e-mail <span className="text-accent-ink">*</span>
                    </label>
                    <input
                      id="contact-email"
                      name="email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      required
                      maxLength={254}
                      value={values.email}
                      onChange={updateField}
                      disabled={phase === 'submitting'}
                      aria-invalid={Boolean(errors.email)}
                      aria-describedby={
                        errors.email ? 'contact-email-error' : undefined
                      }
                      className={cn(
                        fieldBase,
                        errors.email && 'border-accent-ink',
                      )}
                    />
                    {errors.email ? (
                      <p
                        id="contact-email-error"
                        className="text-accent-ink mt-2 text-xs"
                      >
                        {errors.email}
                      </p>
                    ) : null}
                  </div>

                  <div className="sm:col-span-2">
                    <div className="flex items-baseline justify-between gap-4">
                      <label
                        htmlFor="contact-phone"
                        className="text-strong text-xs font-medium tracking-[0.12em] uppercase"
                      >
                        Téléphone
                      </label>
                      <span className="text-subtle text-[0.6875rem] tracking-wide uppercase">
                        Facultatif · non vérifié
                      </span>
                    </div>
                    <input
                      id="contact-phone"
                      name="phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      maxLength={32}
                      value={values.phone}
                      onChange={updateField}
                      disabled={phase === 'submitting'}
                      className={fieldBase}
                    />
                  </div>

                  <div key={mode} className="state-enter sm:col-span-2">
                    <label
                      htmlFor="contact-content"
                      className="text-strong text-xs font-medium tracking-[0.12em] uppercase"
                    >
                      {copy.textLabel}{' '}
                      <span className="text-accent-ink">*</span>
                    </label>
                    <p
                      id="contact-content-hint"
                      className="text-subtle mt-2 text-xs leading-5"
                    >
                      {copy.textHint}
                    </p>
                    <textarea
                      id="contact-content"
                      name="content"
                      required
                      minLength={10}
                      maxLength={2000}
                      rows={5}
                      value={values.content}
                      onChange={updateField}
                      disabled={phase === 'submitting'}
                      aria-invalid={Boolean(errors.content)}
                      aria-describedby={
                        errors.content
                          ? 'contact-content-hint contact-content-error'
                          : 'contact-content-hint'
                      }
                      className={cn(
                        fieldBase,
                        'min-h-40 resize-y leading-7',
                        errors.content && 'border-accent-ink',
                      )}
                    />
                    {errors.content ? (
                      <p
                        id="contact-content-error"
                        className="text-accent-ink mt-2 text-xs"
                      >
                        {errors.content}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div
                  aria-hidden="true"
                  className="absolute left-[-10000px] h-px w-px overflow-hidden"
                >
                  <label htmlFor="contact-website">Site web</label>
                  <input
                    id="contact-website"
                    name="website"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={values.website}
                    onChange={updateField}
                  />
                </div>

                {turnstileSiteKey ? (
                  <div className="mt-8">
                    <TurnstileWidget
                      siteKey={turnstileSiteKey}
                      resetSignal={turnstileReset}
                      onToken={(token) => {
                        setTurnstileToken(token)
                        if (token) {
                          setErrors((current) => ({
                            ...current,
                            turnstile: undefined,
                          }))
                        }
                      }}
                      onUnavailable={() => {
                        setErrors((current) => ({
                          ...current,
                          turnstile:
                            'La vérification anti-robot est indisponible. Rechargez la page.',
                        }))
                      }}
                    />
                    {errors.turnstile ? (
                      <p className="text-accent-ink mt-2 text-xs" role="alert">
                        {errors.turnstile}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="border-line mt-10 flex flex-col gap-5 border-t pt-8 sm:flex-row sm:items-center sm:justify-between">
                  <div
                    aria-live="polite"
                    aria-atomic="true"
                    className={cn(
                      'min-h-6 max-w-sm text-sm leading-6',
                      phase === 'error' ? 'text-accent-ink' : 'text-muted',
                      phase === 'error' && 'state-enter',
                    )}
                  >
                    {statusMessage}
                  </div>
                  <button
                    type="submit"
                    disabled={phase === 'submitting'}
                    className="bg-accent text-accent-contrast hover:bg-accent-hover inline-flex min-h-12 w-full shrink-0 items-center justify-center gap-3 px-6 text-sm font-medium transition-colors disabled:cursor-wait disabled:opacity-70 sm:w-auto"
                  >
                    {phase === 'submitting' ? (
                      <>
                        <LoaderCircle
                          aria-hidden="true"
                          size={17}
                          className="animate-spin motion-reduce:animate-none"
                        />
                        Envoi en cours
                      </>
                    ) : (
                      <>
                        {copy.submitLabel}
                        <ArrowRight aria-hidden="true" size={17} />
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </Container>
    </section>
  )
}
