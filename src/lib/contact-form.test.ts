import { describe, expect, it } from 'vitest'
import {
  CONTACT_MODES,
  createIdempotencyKey,
  EMPTY_CONTACT_FORM,
  validateContactForm,
} from './contact-form'

describe('formulaire de contact', () => {
  it('porte les deux modes et leurs libellés spécifiques', () => {
    expect(CONTACT_MODES.devis.textLabel).toBe('Votre projet')
    expect(CONTACT_MODES.contact.textLabel).toBe('Votre message')
  })

  it('valide les trois champs obligatoires sans imposer le téléphone', () => {
    expect(validateContactForm(EMPTY_CONTACT_FORM)).toEqual({
      name: 'Indiquez votre nom.',
      email: 'Indiquez une adresse e-mail valide.',
      content: 'Écrivez votre message.',
    })

    expect(
      validateContactForm({
        ...EMPTY_CONTACT_FORM,
        name: 'Miora',
        email: 'miora@example.mg',
        content: 'Un message suffisamment précis.',
      }),
    ).toEqual({})
  })

  it('génère une clé compatible avec le contrat du Worker', () => {
    expect(createIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
  })
})
