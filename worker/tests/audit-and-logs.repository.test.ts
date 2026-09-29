/**
 * Tests d'intégration du journal d'audit, de l'historique des demandes et de la
 * limitation d'abus.
 *
 * Ces trois tables forment la traçabilité et la protection du service. Ce qui est
 * vérifié ici : le journal d'audit reste exploitable (qui, quoi, quand, résultat),
 * ne peut pas accueillir un texte libre long (donc pas de donnée personnelle), et
 * n'accepte pas d'action anonyme ; l'historique d'une demande est ordonné et borné,
 * et refuse un changement d'état incohérent ou une action administrative non
 * attribuée ; la limitation d'abus compte des tentatives par cible et par action
 * sur une fenêtre glissante, sans jamais stocker de valeur en clair.
 *
 * Les valeurs de test sont fictives et les dates fixes : aucun accès réseau.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appendAuditLog,
  listAuditLogForEntity,
  type AuditEntityType,
} from '../src/db/repositories/audit-log'
import { createQuoteRequest } from '../src/db/repositories/quote-requests'
import {
  countRateLimitHits,
  purgeRateLimitHits,
  recordRateLimitHit,
  type RateLimitScope,
} from '../src/db/repositories/rate-limit'
import {
  appendRequestEvent,
  listRequestEvents,
} from '../src/db/repositories/request-events'
import { createAdminUser } from '../src/db/repositories/users'
import { createTestDatabase, type TestDatabase } from './helpers/database'

/** Instant de référence : 2027-01-15T08:00:00Z. */
const NOW = 1_800_000_000
/** Empreintes fictives : la base n'accepte que des empreintes, jamais des valeurs. */
const KEY_HASH = 'a1'.repeat(32)
const OTHER_KEY_HASH = 'b2'.repeat(32)

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})

afterAll(async () => {
  await database.dispose()
})

let sequence = 0

/** Crée une demande de test et renvoie son identifiant interne. */
async function createQuote(now = NOW): Promise<number> {
  sequence += 1
  const reference = `DEV-2027-${String(sequence).padStart(8, '0')}`
  const outcome = await createQuoteRequest(database.db, {
    reference,
    idempotencyKey: `idem-${reference}`,
    phoneNormalized: `+2613499${String(10_000 + sequence)}`,
    phoneRaw: `+2613499${String(10_000 + sequence)}`,
    description: 'Portail coulissant en aluminium, largeur 4 m, hors pose.',
    contactName: 'Test local',
    contactEmail: 'test@example.test',
    now,
  })
  return outcome.quote.id
}

/** Crée un compte administratif de test (auteur des actions auditées). */
async function createActor(): Promise<number> {
  sequence += 1
  const account = await createAdminUser(database.db, {
    email: `audit${sequence}@m3design.test`,
    displayName: `Administration ${sequence}`,
    passwordHash:
      '$argon2id$v=19$m=65536,t=3,p=1$c2VsZGV0ZXN0c2Vs$empreintefictivepourtests',
    now: NOW,
  })
  return account.id
}

describe('journal d’audit', () => {
  it('enregistre une action administrative avec son auteur, son résultat et sa cible', async () => {
    const actorUserId = await createActor()

    const entry = await appendAuditLog(database.db, {
      action: 'quote.close',
      entityType: 'quote_request',
      entityReference: 'DEV-2027-00000042',
      outcome: 'success',
      actorUserId,
      reason: 'devis transmis',
      now: NOW,
    })

    expect(entry).toMatchObject({
      occurred_at: NOW,
      action: 'quote.close',
      entity_type: 'quote_request',
      entity_reference: 'DEV-2027-00000042',
      outcome: 'success',
      actor_user_id: actorUserId,
      reason: 'devis transmis',
    })

    // Une tentative refusée est conservée aussi : c'est justement ce qu'un audit
    // doit permettre de relire après un incident.
    const denied = await appendAuditLog(database.db, {
      action: 'session.revoke',
      entityType: 'session',
      outcome: 'denied',
      reason: 'session inconnue',
      now: NOW + 1,
    })
    expect(denied.actor_user_id).toBeNull()
    expect(denied.entity_reference).toBeNull()
    expect(denied.outcome).toBe('denied')
  })

  it('refuse un texte libre long, une action trop courte et un type d’entité inconnu', async () => {
    // Ces bornes sont la garantie qu'aucun message client ni numéro ne peut être
    // recopié dans le journal (un « motif » technique reste court).
    await expect(
      appendAuditLog(database.db, {
        action: 'quote.close',
        entityType: 'quote_request',
        outcome: 'success',
        reason: 'x'.repeat(301),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(
      appendAuditLog(database.db, {
        action: 'ab',
        entityType: 'quote_request',
        outcome: 'success',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    // Un type d'entité hors de la liste fermée du schéma est refusé par la base
    // elle-même : la contrainte reste la garantie de dernier recours, même si un
    // type TypeScript était élargi par erreur. D'où le forçage volontaire du type.
    await expect(
      appendAuditLog(database.db, {
        action: 'quote.close',
        entityType: 'client' as AuditEntityType,
        outcome: 'success',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(
      appendAuditLog(database.db, {
        action: 'quote.close',
        entityType: 'quote_request',
        entityReference: 'R'.repeat(65),
        outcome: 'success',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    // Un auteur inconnu ne peut pas être attribué à une action.
    await expect(
      appendAuditLog(database.db, {
        action: 'quote.close',
        entityType: 'quote_request',
        outcome: 'success',
        actorUserId: 999_999,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('relit l’historique d’une entité, du plus récent au plus ancien et borné', async () => {
    const reference = 'DEV-2027-00009901'
    const otherReference = 'DEV-2027-00009902'

    for (const [index, action] of [
      'quote.open',
      'quote.verify',
      'quote.close',
    ].entries()) {
      await appendAuditLog(database.db, {
        action,
        entityType: 'quote_request',
        entityReference: reference,
        outcome: 'success',
        now: NOW + index,
      })
    }
    await appendAuditLog(database.db, {
      action: 'quote.open',
      entityType: 'quote_request',
      entityReference: otherReference,
      outcome: 'success',
      now: NOW + 10,
    })

    const history = await listAuditLogForEntity(database.db, {
      entityType: 'quote_request',
      entityReference: reference,
    })
    expect(history.map((row) => row.action)).toEqual([
      'quote.close',
      'quote.verify',
      'quote.open',
    ])
    expect(history.every((row) => row.entity_reference === reference)).toBe(
      true,
    )

    // Lecture bornée : utile pour l'affichage, sans charge imprévisible.
    const bounded = await listAuditLogForEntity(database.db, {
      entityType: 'quote_request',
      entityReference: reference,
      limit: 1,
    })
    expect(bounded.map((row) => row.action)).toEqual(['quote.close'])

    // Une entité différente n'apparaît pas dans l'historique.
    expect(
      await listAuditLogForEntity(database.db, {
        entityType: 'quote_request',
        entityReference: 'DEV-2027-99999999',
      }),
    ).toEqual([])
  })
})

describe('historique des demandes', () => {
  it('ajoute un événement et le relit du plus ancien au plus récent', async () => {
    const quoteId = await createQuote()
    const actorUserId = await createActor()

    // La création de la demande a déjà écrit son événement d'ouverture : c'est le
    // point de départ de l'historique, écrit dans la même transaction que la ligne.
    const [created] = await listRequestEvents(database.db, {
      quoteRequestId: quoteId,
    })
    expect(created).toMatchObject({
      quote_request_id: quoteId,
      event_type: 'created',
      from_status: null,
      to_status: 'new',
      actor: 'client',
      actor_user_id: null,
      created_at: NOW,
    })

    await appendRequestEvent(database.db, {
      quoteRequestId: quoteId,
      eventType: 'status_changed',
      actor: 'admin',
      actorUserId,
      fromStatus: 'new',
      toStatus: 'in_progress',
      reason: 'devis en cours de chiffrage',
      now: NOW + 10,
    })
    await appendRequestEvent(database.db, {
      quoteRequestId: quoteId,
      eventType: 'notification_queued',
      actor: 'system',
      toStatus: 'in_progress',
      now: NOW + 20,
    })

    const events = await listRequestEvents(database.db, {
      quoteRequestId: quoteId,
    })
    expect(events.map((event) => event.event_type)).toEqual([
      'created',
      'status_changed',
      'notification_queued',
    ])
    expect(events[1]).toMatchObject({
      actor: 'admin',
      actor_user_id: actorUserId,
      from_status: 'new',
      to_status: 'in_progress',
    })

    // Un historique est borné : la lecture ne peut pas rendre la table entière.
    const bounded = await listRequestEvents(database.db, {
      quoteRequestId: quoteId,
      limit: 1,
    })
    expect(bounded).toHaveLength(1)
    expect(bounded[0]?.event_type).toBe('created')

    // Une autre demande n'apparaît pas dans cet historique.
    expect(
      await listRequestEvents(database.db, { quoteRequestId: 999_999 }),
    ).toEqual([])
  })

  it('refuse un événement incohérent : changement d’état incomplet, action non attribuée', async () => {
    const quoteId = await createQuote()
    const actorUserId = await createActor()

    // Un changement d'état doit porter ses deux états.
    await expect(
      appendRequestEvent(database.db, {
        quoteRequestId: quoteId,
        eventType: 'status_changed',
        actor: 'admin',
        actorUserId,
        toStatus: 'in_progress',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    // Une action administrative doit toujours désigner le compte auteur.
    await expect(
      appendRequestEvent(database.db, {
        quoteRequestId: quoteId,
        eventType: 'status_changed',
        actor: 'admin',
        fromStatus: 'new',
        toStatus: 'in_progress',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    // Un événement ne peut pas viser une demande inexistante.
    await expect(
      appendRequestEvent(database.db, {
        quoteRequestId: 999_999,
        eventType: 'created',
        actor: 'client',
        toStatus: 'new',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    // Le motif reste un code technique court, jamais un message client.
    await expect(
      appendRequestEvent(database.db, {
        quoteRequestId: quoteId,
        eventType: 'corrected',
        actor: 'system',
        reason: 'x'.repeat(301),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('limitation d’abus', () => {
  it('compte les tentatives par cible et par action, sur une fenêtre glissante', async () => {
    for (const offset of [0, 10, 20]) {
      await recordRateLimitHit(database.db, {
        scope: 'quote_submit',
        keyHash: KEY_HASH,
        now: NOW + offset,
      })
    }
    // Autre cible, autre action : ces tentatives ne comptent pas pour la première.
    await recordRateLimitHit(database.db, {
      scope: 'quote_submit',
      keyHash: OTHER_KEY_HASH,
      now: NOW + 30,
    })
    await recordRateLimitHit(database.db, {
      scope: 'contact_submit',
      keyHash: KEY_HASH,
      now: NOW + 30,
    })

    expect(
      await countRateLimitHits(database.db, {
        scope: 'quote_submit',
        keyHash: KEY_HASH,
        since: NOW,
      }),
    ).toBe(3)
    expect(
      await countRateLimitHits(database.db, {
        scope: 'quote_submit',
        keyHash: KEY_HASH,
        since: NOW + 15,
      }),
    ).toBe(1)
    expect(
      await countRateLimitHits(database.db, {
        scope: 'quote_submit',
        keyHash: OTHER_KEY_HASH,
        since: NOW,
      }),
    ).toBe(1)
    expect(
      await countRateLimitHits(database.db, {
        scope: 'contact_submit',
        keyHash: KEY_HASH,
        since: NOW,
      }),
    ).toBe(1)
  })

  it('refuse une cible qui ne serait pas une empreinte', async () => {
    // Aucun numéro, aucune adresse ne doit pouvoir être écrit en clair dans la table.
    await expect(
      recordRateLimitHit(database.db, {
        scope: 'quote_submit',
        keyHash: '+261340000000',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(
      countRateLimitHits(database.db, {
        scope: 'admin_login',
        keyHash: 'adresse@example.test',
        since: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    // Une action hors de la liste fermée du schéma est refusée par la base.
    await expect(
      recordRateLimitHit(database.db, {
        scope: 'scope_inconnu' as RateLimitScope,
        keyHash: KEY_HASH,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('purge les tentatives antérieures à la date demandée', async () => {
    await recordRateLimitHit(database.db, {
      scope: 'admin_login',
      keyHash: KEY_HASH,
      now: NOW,
    })
    await recordRateLimitHit(database.db, {
      scope: 'admin_login',
      keyHash: OTHER_KEY_HASH,
      now: NOW - 3_600,
    })

    const purged = await purgeRateLimitHits(database.db, { before: NOW - 60 })
    expect(purged).toBeGreaterThanOrEqual(1)

    // La tentative récente reste comptée : la fenêtre glissante est préservée.
    expect(
      await countRateLimitHits(database.db, {
        scope: 'admin_login',
        keyHash: KEY_HASH,
        since: 0,
      }),
    ).toBe(1)
    expect(
      await countRateLimitHits(database.db, {
        scope: 'admin_login',
        keyHash: OTHER_KEY_HASH,
        since: 0,
      }),
    ).toBe(0)
  })
})
