/**
 * JEU DE TEST LOCAL — dépose UNE demande de test et sa notification dans la base de
 * DÉVELOPPEMENT, sans rien envoyer.
 *
 * Pourquoi ce fichier : le premier envoi réel a besoin d'une notification en attente.
 * Or, à ce stade, aucune demande ne peut être créée par le site (le frontend n'est
 * pas encore branché sur l'API) ni par l'API elle-même (la vérification WhatsApp
 * exige un compte Meta configuré). Ce fichier comble ce seul manque : il écrit une
 * demande de test et sa notification dans la file, par le MÊME code que
 * l'application (`createQuoteRequest` + `buildQuoteNotification`), puis affiche la
 * référence publique à donner au test d'envoi réel.
 *
 * Trois précautions :
 *   * il travaille EXCLUSIVEMENT sur la base LOCALE de développement
 *     (`.wrangler/state/v3`) et refuse de tourner si `ENVIRONMENT=production` ;
 *   * il n'envoie RIEN : il écrit une ligne de file, rien de plus ;
 *   * les données sont étiquetées comme un test — le numéro est un numéro de test et
 *     la description commence par « Jeu de test local ». La ligne « Numéro WhatsApp
 *     vérifié » est donc SYNTHÉTIQUE ici : elle vient du gabarit du courriel, alors
 *     que la vérification WhatsApp n'est pas configurée dans cet environnement. Le
 *     but est de valider le TRANSPORT (Resend → boîte configurée), pas le parcours
 *     client complet.
 *
 * Usage :
 *   EMAIL_SEED=1 pnpm vitest run worker/tests/real-send.seed.manual.test.ts
 *
 * Puis, avec la référence affichée :
 *   EMAIL_REAL_SEND=1 EMAIL_REAL_SEND_REFERENCE=DEV-2027-XXXXXXXX \
 *     pnpm vitest run worker/tests/real-send.manual.test.ts
 */

import { describe, expect, it } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import { nowSeconds } from '../src/db/client'
import { createQuoteRequest } from '../src/db/repositories/quote-requests'
import {
  buildQuoteNotification,
  readNotificationRecipient,
} from '../src/services/notifications'
import { generateQuoteReference } from '../src/services/quote-reference'
import type { AppEnv } from '../src/types'

/** Vrai uniquement si l'opérateur a explicitement demandé ce dépôt de test. */
const ENABLED = process.env.EMAIL_SEED === '1'

/** État local de Wrangler, tel que `pnpm dev` l'écrit. */
const PERSIST_PATH = '.wrangler/state/v3'

/** Numéro de test : jamais un numéro de client. */
const TEST_PHONE = '+261340000000'

/** Description qui ne peut pas être prise pour une vraie demande. */
const TEST_DESCRIPTION =
  'Jeu de test local — aucune demande client. Ce courriel sert à vérifier la chaîne d’envoi (Resend vers la boîte configurée).'

/** Nom de test, pour la même raison. */
const TEST_CONTACT_NAME = 'Jeu de test local M3Design'

/** Adresse masquée : de quoi reconnaître la boîte sans l'écrire dans un journal. */
function maskEmail(address: string): string {
  const at = address.indexOf('@')
  return at <= 0 ? '***' : `${address.slice(0, 1)}***${address.slice(at)}`
}

describe.skipIf(!ENABLED)('jeu de test local : une demande en attente', () => {
  it('dépose la demande et sa notification, sans rien envoyer', async () => {
    const proxy = await getPlatformProxy({
      configPath: 'wrangler.jsonc',
      persist: { path: PERSIST_PATH },
    })

    try {
      const env = proxy.env as unknown as AppEnv['Bindings']
      const environment = (env.ENVIRONMENT ?? '').trim()
      if (environment === 'production') {
        throw new Error(
          'ENVIRONMENT=production : ce jeu de test n’écrit que dans la base locale de développement',
        )
      }

      const now = nowSeconds()
      const recipient = readNotificationRecipient(env)
      const reference = generateQuoteReference({
        year: new Date(now * 1000).getUTCFullYear(),
      })
      const notification = buildQuoteNotification({
        recipient,
        reference,
        phoneNormalized: TEST_PHONE,
        receivedAt: now,
        description: TEST_DESCRIPTION,
        contactName: TEST_CONTACT_NAME,
        contactEmail: 'test@example.test',
      })

      const outcome = await createQuoteRequest(env.DB, {
        reference,
        idempotencyKey: `jeu-de-test-${reference}`,
        phoneNormalized: TEST_PHONE,
        phoneRaw: TEST_PHONE,
        description: TEST_DESCRIPTION,
        contactName: TEST_CONTACT_NAME,
        contactEmail: 'test@example.test',
        notification,
        now,
      })

      // La demande et sa notification sont écrites ensemble : soit les deux, soit
      // aucune. Une demande que personne ne verrait ne peut pas exister.
      expect(outcome.replayed).toBe(false)
      expect(outcome.notificationQueued).toBe(true)

      console.log(`[email] référence de test : ${reference}`)
      console.log(`[email] destinataire : ${maskEmail(recipient)}`)
      console.log(
        '[email] rien n’a été envoyé : lancez le test d’envoi réel avec cette référence.',
      )
    } finally {
      await proxy.dispose()
    }
  })
})
