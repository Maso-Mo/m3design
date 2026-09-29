/**
 * Tests du dépôt des demandes de devis, sur une vraie base D1 locale.
 *
 * Ce fichier couvre ce que la BASE garantit, et non ce que le service décide :
 * l'état initial, l'idempotence, l'unicité d'un téléphone actif, le graphe des
 * transitions d'état, l'anonymisation, et le fait qu'une demande de la V1 ne peut
 * pas exister sans nom, sans adresse électronique ni texte.
 *
 * Les notifications sont vérifiées ici aussi : une demande acceptée crée EXACTEMENT
 * une notification, dans le même lot, et un rejeu n'en ajoute aucune.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  anonymizeClosedQuoteRequests,
  createQuoteRequest,
  findQuoteRequestByIdempotencyKey,
  findQuoteRequestByReference,
  updateQuoteRequestStatus,
} from '../src/db/repositories/quote-requests'
import { listRequestEvents } from '../src/db/repositories/request-events'
import {
  clearOperationalTables,
  createTestDatabase,
  type TestDatabase,
} from './helpers/database'

/** Instant de référence : 2027-01-15T08:00:00Z. */
const NOW = 1_800_000_000
const RECIPIENT = 'notifications@m3design.test'

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.dispose()
})

beforeEach(async () => {
  await clearOperationalTables(database.db)
})

let sequence = 0

/** Crée une demande, avec sa notification, par le chemin normal. */
async function createRequest(
  options: {
    phone?: string | null
    email?: string | null
    name?: string
    description?: string
    idempotencyKey?: string
    now?: number
    withNotification?: boolean
  } = {},
) {
  sequence += 1
  const reference = `DEV-2027-${String(sequence).padStart(8, '0')}`
  const email =
    options.email === undefined
      ? `client${String(sequence)}@example.com`
      : options.email
  const outcome = await createQuoteRequest(database.db, {
    reference,
    idempotencyKey:
      options.idempotencyKey ??
      `cle-idempotence-${String(sequence).padStart(6, '0')}`,
    phoneNormalized: options.phone ?? null,
    phoneRaw: options.phone ?? null,
    contactName: options.name ?? 'Client de test',
    contactEmail: email,
    description:
      options.description ?? 'Portail coulissant en aluminium, largeur 4 m.',
    ...(options.withNotification === false
      ? {}
      : {
          notification: {
            recipient: RECIPIENT,
            subject: `Nouvelle demande de devis ${reference}`,
            bodyText: 'Corps du courriel de notification.',
          },
        }),
    now: options.now ?? NOW,
  })
  return outcome
}

/** Compte les lignes d'une table. */
async function count(table: string): Promise<number> {
  const row = await database.db
    .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
    .first<{ total: number }>()
  return row?.total ?? 0
}

/** Compte les demandes d'un téléphone donné. */
async function countForPhone(phone: string): Promise<number> {
  const row = await database.db
    .prepare(
      `SELECT COUNT(*) AS total FROM quote_requests WHERE phone_normalized = ?1`,
    )
    .bind(phone)
    .first<{ total: number }>()
  return row?.total ?? 0
}

describe('création d’une demande', () => {
  it('enregistre une demande « new » de formulaire V1, avec sa notification', async () => {
    const outcome = await createRequest({ phone: '+261340000001' })

    expect(outcome.replayed).toBe(false)
    expect(outcome.notificationQueued).toBe(true)
    expect(outcome.quote).toMatchObject({
      status: 'new',
      intake_version: 2,
      phone_normalized: '+261340000001',
      contact_name: 'Client de test',
      created_at: NOW,
    })
    expect(await count('quote_requests')).toBe(1)
    expect(await count('email_outbox')).toBe(1)
    expect(await count('request_events')).toBe(1)
  })

  it('rejoue une clé connue sans créer de doublon ni de notification', async () => {
    const first = await createRequest({
      idempotencyKey: 'cle-idempotence-rejeu-01',
    })
    expect(await count('email_outbox')).toBe(1)

    const replayed = await createRequest({
      idempotencyKey: 'cle-idempotence-rejeu-01',
    })
    expect(replayed.replayed).toBe(true)
    expect(replayed.notificationQueued).toBe(false)
    expect(replayed.quote.reference).toBe(first.quote.reference)
    expect(await count('quote_requests')).toBe(1)
    expect(await count('email_outbox')).toBe(1)
    expect(await count('request_events')).toBe(1)
  })

  it('refuse une demande V1 sans adresse électronique', async () => {
    await expect(createRequest({ email: null })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    expect(await count('quote_requests')).toBe(0)
    expect(await count('email_outbox')).toBe(0)
  })

  it('refuse une référence déjà utilisée', async () => {
    const first = await createRequest()
    await expect(
      createQuoteRequest(database.db, {
        reference: first.quote.reference,
        idempotencyKey: 'cle-idempotence-collision-1',
        phoneNormalized: null,
        phoneRaw: null,
        contactName: 'Autre client',
        contactEmail: 'autre@example.com',
        description: 'Une autre description assez longue.',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'quote_reference_conflict' })
  })

  it('peut créer plusieurs demandes sans téléphone', async () => {
    await createRequest({ phone: null })
    await createRequest({ phone: null })
    expect(await count('quote_requests')).toBe(2)
  })
})

describe('unicité d’un téléphone actif', () => {
  it('refuse une seconde demande active puis la libère à la clôture', async () => {
    const phone = '+261340000002'
    const first = await createRequest({ phone })

    await expect(createRequest({ phone })).rejects.toMatchObject({
      code: 'quote_already_active',
    })
    expect(await countForPhone(phone)).toBe(1)

    const admin = await createAdmin()
    await updateQuoteRequestStatus(database.db, {
      quoteId: first.quote.id,
      toStatus: 'in_progress',
      actor: 'admin',
      actorUserId: admin,
      now: NOW + 10,
    })
    await updateQuoteRequestStatus(database.db, {
      quoteId: first.quote.id,
      toStatus: 'closed',
      actor: 'admin',
      actorUserId: admin,
      now: NOW + 20,
    })

    const second = await createRequest({ phone, now: NOW + 30 })
    expect(second.quote.id).not.toBe(first.quote.id)
    expect(second.quote.status).toBe('new')
    expect(await countForPhone(phone)).toBe(2)
  })
})

/* ------------------------------------------------------------------ support */

/** Crée un compte administratif unique, pour tracer les changements d'état. */
let adminUserId: number | null = null

async function createAdmin(): Promise<number> {
  if (adminUserId !== null) {
    return adminUserId
  }
  // Schéma réel de `users` (migration 0002) : l'empreinte de mot de passe est au
  // format modulaire `$…$…$…`, et le rôle du compte n'est pas porté par cette table.
  const row = await database.db
    .prepare(
      `INSERT INTO users (email, display_name, password_hash, status,
                          created_at, updated_at)
       VALUES ('admin@m3design.test', 'Administrateur de test',
               '$argon2id$v=19$m=65536,t=3,p=4$empreinte-de-test-0123456789',
               'active', ?1, ?1)
       RETURNING id`,
    )
    .bind(NOW)
    .first<{ id: number }>()
  adminUserId = row?.id ?? 0
  return adminUserId
}

describe('graphe des transitions d’état', () => {
  it('avance de new à closed, journalise chaque étape, et n’en sort plus', async () => {
    const quote = await createRequest()
    const admin = await createAdmin()

    const started = await updateQuoteRequestStatus(database.db, {
      quoteId: quote.quote.id,
      toStatus: 'in_progress',
      actor: 'admin',
      actorUserId: admin,
      reason: 'prise en charge',
      now: NOW + 60,
    })
    expect(started).toMatchObject({ status: 'in_progress', closed_at: null })

    const closed = await updateQuoteRequestStatus(database.db, {
      quoteId: quote.quote.id,
      toStatus: 'closed',
      actor: 'admin',
      actorUserId: admin,
      reason: 'devis envoyé',
      now: NOW + 70,
    })
    expect(closed).toMatchObject({ status: 'closed', closed_at: NOW + 70 })

    // `closed` est final : aucune réouverture, aucune double clôture.
    for (const toStatus of ['in_progress', 'closed'] as const) {
      await expect(
        updateQuoteRequestStatus(database.db, {
          quoteId: quote.quote.id,
          toStatus,
          actor: 'admin',
          actorUserId: admin,
          now: NOW + 80,
        }),
      ).rejects.toMatchObject({ code: 'quote_status_transition_refused' })
    }

    const events = await listRequestEvents(database.db, {
      quoteRequestId: quote.quote.id,
    })
    expect(
      events.map(
        (event) =>
          `${event.event_type}:${event.from_status}->${event.to_status}`,
      ),
    ).toEqual([
      'created:null->new',
      'status_changed:new->in_progress',
      'status_changed:in_progress->closed',
    ])
    expect(events[1]).toMatchObject({ actor: 'admin', actor_user_id: admin })
    expect(events[2]?.reason).toBe('devis envoyé')
  })

  it('refuse une demande inconnue et une cible hors du graphe', async () => {
    await expect(
      updateQuoteRequestStatus(database.db, {
        quoteId: 999_999,
        toStatus: 'closed',
        actor: 'admin',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'quote_not_found' })

    const quote = await createRequest()
    await expect(
      updateQuoteRequestStatus(database.db, {
        quoteId: quote.quote.id,
        // @ts-expect-error — cible volontairement invalide : la base ne doit jamais
        // accepter « new » comme état d'arrivée d'un changement d'état.
        toStatus: 'new',
        actor: 'client',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'quote_status_transition_refused' })
  })
})

describe('conservation des données personnelles', () => {
  it('efface les données des demandes clôturées assez anciennes, et rien d’autre', async () => {
    const quote = await createRequest({ phone: '+261340000003' })
    const admin = await createAdmin()
    await updateQuoteRequestStatus(database.db, {
      quoteId: quote.quote.id,
      toStatus: 'closed',
      actor: 'admin',
      actorUserId: admin,
      now: NOW + 100,
    })

    // Trop récent : rien n'est touché.
    expect(
      await anonymizeClosedQuoteRequests(database.db, {
        closedBefore: NOW,
        now: NOW + 200,
      }),
    ).toBe(0)
    const untouched = await findQuoteRequestByReference(
      database.db,
      quote.quote.reference,
    )
    expect(untouched?.phone_normalized).toBe('+261340000003')
    expect(untouched?.anonymized_at).toBeNull()

    // Assez ancien : les données personnelles disparaissent, la référence reste.
    expect(
      await anonymizeClosedQuoteRequests(database.db, {
        closedBefore: NOW + 100,
        now: NOW + 200,
      }),
    ).toBe(1)

    const anonymized = await findQuoteRequestByReference(
      database.db,
      quote.quote.reference,
    )
    expect(anonymized).toMatchObject({
      id: quote.quote.id,
      reference: quote.quote.reference,
      status: 'closed',
      phone_normalized: null,
      phone_raw: null,
      contact_name: null,
      contact_email: null,
      description: null,
      anonymized_at: NOW + 200,
      created_at: quote.quote.created_at,
    })

    // L'historique conserve la trace de l'effacement.
    const events = await listRequestEvents(database.db, {
      quoteRequestId: quote.quote.id,
    })
    expect(events.map((event) => event.event_type)).toEqual([
      'created',
      'status_changed',
      'anonymized',
    ])
  })

  it('laisse intactes les demandes encore ouvertes', async () => {
    const quote = await createRequest({ phone: '+261340000004' })

    expect(
      await anonymizeClosedQuoteRequests(database.db, {
        closedBefore: NOW + 10_000,
        now: NOW + 20_000,
      }),
    ).toBe(0)
    const kept = await findQuoteRequestByIdempotencyKey(
      database.db,
      quote.quote.idempotency_key,
    )
    expect(kept?.contact_email).not.toBeNull()
  })
})
