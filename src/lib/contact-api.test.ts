import { describe, expect, it, vi } from 'vitest'
import {
  ContactSubmissionError,
  contactErrorMessage,
  submitContactForm,
} from './contact-api'
import { EMPTY_CONTACT_FORM } from './contact-form'

const values = {
  ...EMPTY_CONTACT_FORM,
  name: 'Miora',
  email: 'MIORA@example.mg',
  phone: '+261 34 00 000 00',
  content: 'Une demande complète pour le projet.',
}

const successBody = {
  reference: 'DEV-2026-ABCDEFGH',
  status: 'new',
  replayed: false,
  notificationQueued: true,
  phoneMasked: '+261•••••00',
  submittedAt: 1_800_000_000,
}

function jsonResponse(body: unknown, status: number, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('client des formulaires Contact', () => {
  it('envoie un devis sur /api/devis avec description et les protections', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(successBody, 201))

    await submitContactForm('devis', values, {
      idempotencyKey: 'fixed-request-key-1234',
      turnstileToken: 'turnstile-token',
      fetchImplementation,
    })

    expect(fetchImplementation).toHaveBeenCalledOnce()
    const [url, init] = fetchImplementation.mock.calls[0] ?? []
    expect(url).toBe('/api/devis')
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Miora',
      email: 'MIORA@example.mg',
      phone: '+261 34 00 000 00',
      description: 'Une demande complète pour le projet.',
      idempotencyKey: 'fixed-request-key-1234',
      website: '',
      turnstileToken: 'turnstile-token',
    })
  })

  it('envoie un contact sur /api/contact avec message et sans Turnstile absent', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { ...successBody, reference: 'MSG-2026-ABCDEFGH', replayed: true },
          200,
        ),
      )

    const result = await submitContactForm('contact', values, {
      idempotencyKey: 'fixed-request-key-1234',
      fetchImplementation,
    })

    const [url, init] = fetchImplementation.mock.calls[0] ?? []
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(url).toBe('/api/contact')
    expect(body.message).toBe(values.content)
    expect(body).not.toHaveProperty('description')
    expect(body).not.toHaveProperty('turnstileToken')
    expect(result.replayed).toBe(true)
  })

  it('réutilise sans la modifier la même clé lors d’un rejeu', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(successBody, 201))
      .mockResolvedValueOnce(
        jsonResponse({ ...successBody, replayed: true }, 200),
      )
    const options = {
      idempotencyKey: 'same-logical-request-123',
      fetchImplementation,
    }

    await submitContactForm('devis', values, options)
    await submitContactForm('devis', values, options)

    const keys = fetchImplementation.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { idempotencyKey: string }
      return body.idempotencyKey
    })
    expect(keys).toEqual([
      'same-logical-request-123',
      'same-logical-request-123',
    ])
  })

  it.each([
    [400, 'invalid_request'],
    [409, 'request_rejected'],
    [503, 'service_unavailable'],
  ])('conserve le statut %i et le code %s', async (status, code) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { code } }, status))

    await expect(
      submitContactForm('devis', values, {
        idempotencyKey: 'fixed-request-key-1234',
        fetchImplementation,
      }),
    ).rejects.toMatchObject({ status, code })
  })

  it('lit Retry-After sur une réponse 429 sans relancer automatiquement', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: 'too_many_requests', retryAfterSeconds: 10 } },
          429,
          { 'Retry-After': '3600' },
        ),
      )

    let captured: unknown
    try {
      await submitContactForm('contact', values, {
        idempotencyKey: 'fixed-request-key-1234',
        fetchImplementation,
      })
    } catch (error) {
      captured = error
    }

    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(captured).toMatchObject({
      status: 429,
      code: 'too_many_requests',
      retryAfterSeconds: 3600,
    })
    expect(contactErrorMessage(captured)).toContain('1 heure')
  })

  it('présente une erreur Turnstile dédiée', () => {
    expect(
      contactErrorMessage(new ContactSubmissionError('challenge_failed', 400)),
    ).toContain('anti-robot')
  })

  it('transforme une panne réseau sans exposer son détail', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('secret network detail'))

    await expect(
      submitContactForm('contact', values, {
        idempotencyKey: 'fixed-request-key-1234',
        fetchImplementation,
      }),
    ).rejects.toEqual(new ContactSubmissionError('network_error', null))
  })
})
