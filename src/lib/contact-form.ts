export type ContactMode = 'devis' | 'contact'

export type ContactFormValues = {
  name: string
  email: string
  phone: string
  content: string
  website: string
}

export type ContactField = 'name' | 'email' | 'content' | 'turnstile'

export type ContactFieldErrors = Partial<Record<ContactField, string>>

export const EMPTY_CONTACT_FORM: ContactFormValues = {
  name: '',
  email: '',
  phone: '',
  content: '',
  website: '',
}

export const CONTACT_MODES: Record<
  ContactMode,
  {
    label: string
    textLabel: string
    textHint: string
    submitLabel: string
  }
> = {
  devis: {
    label: 'Demander un devis',
    textLabel: 'Votre projet',
    textHint: 'Décrivez votre besoin, le lieu et les grandes lignes du projet.',
    submitLabel: 'Envoyer la demande',
  },
  contact: {
    label: 'Nous contacter',
    textLabel: 'Votre message',
    textHint: 'Précisez simplement l’objet de votre message.',
    submitLabel: 'Envoyer le message',
  },
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^\s@]{2,}$/

/** Validation de confort uniquement : le Worker reste la source de vérité. */
export function validateContactForm(
  values: ContactFormValues,
): ContactFieldErrors {
  const errors: ContactFieldErrors = {}

  if (values.name.trim() === '') {
    errors.name = 'Indiquez votre nom.'
  }

  if (!EMAIL_PATTERN.test(values.email.trim())) {
    errors.email = 'Indiquez une adresse e-mail valide.'
  }

  if (values.content.trim() === '') {
    errors.content = 'Écrivez votre message.'
  } else if ([...values.content.trim()].length < 10) {
    errors.content = 'Développez votre message en au moins 10 caractères.'
  }

  return errors
}

/**
 * Une clé vit pendant toute une tentative logique. Elle n'est renouvelée que
 * lorsque le visiteur commence une nouvelle demande après un succès, ou change
 * volontairement de type de demande.
 */
export function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}-request`
}
