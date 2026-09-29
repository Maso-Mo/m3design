/**
 * PREMIER ENVOI RÉEL — réservé à une décision explicite, une seule notification.
 *
 * Ce fichier n'est pas un test comme les autres. Lorsqu'il est activé, il :
 *   * travaille EXCLUSIVEMENT sur la base D1 LOCALE de développement
 *     (`.wrangler/state/v3`, la même que `pnpm dev`, dans un dossier ignoré par
 *     Git) : `getPlatformProxy` ne sait pas parler à une base distante, aucune
 *     ressource Cloudflare n'est contactée ;
 *   * ENVOIE UN VRAI COURRIEL, par le fournisseur configuré dans `.dev.vars`, et à
 *     la boîte configurée dans `NOTIFICATION_EMAIL` ;
 *   * n'envoie QUE la notification désignée par `EMAIL_REAL_SEND_REFERENCE` : les
 *     autres demandes en attente ne sont ni envoyées, ni touchées (le test le
 *     vérifie lui-même, entrée par entrée, après l'envoi).
 *
 * Il est donc NEUTRALISÉ par défaut (`describe.skipIf`) : sans `EMAIL_REAL_SEND=1`,
 * rien ne se passe, et la suite ordinaire (`pnpm test`) ne peut jamais provoquer
 * d'envoi. Aucune clé, aucun destinataire complet, aucun contenu de message n'est
 * affiché : le journal ne porte que des valeurs de configuration non sensibles, une
 * référence publique et des codes techniques.
 *
 * Marche à suivre détaillée : `worker/README.md`, section « premier envoi réel ».
 * En résumé, après avoir déposé une demande depuis le site en développement et noté
 * la référence affichée :
 *
 *   EMAIL_REAL_SEND=1 EMAIL_REAL_SEND_REFERENCE=DEV-2027-XXXXXXXX \
 *     pnpm vitest run worker/tests/real-send.manual.test.ts
 *
 * CE QUE L'ISSUE PROUVE, ET CE QU'ELLE NE PROUVE PAS : l'entrée passe en `sent`
 * parce que le fournisseur a ACCEPTÉ le message et a renvoyé son identifiant. Cela
 * ne prouve pas que le courriel est arrivé : la seule preuve de réception est
 * l'accusé de réception dans la boîte — et dans une boîte grand public, il peut
 * arriver avec du retard ou être classé en courrier indésirable. C'est à l'opérateur
 * de le constater avant de conclure quoi que ce soit.
 */

import { describe, expect, it } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import { nowSeconds } from '../src/db/client'
import { findEmailOutboxByReference } from '../src/db/repositories/email-outbox'
import { readEmailSender } from '../src/providers/email-provider'
import {
  dispatchOneEmail,
  emailDispatchConsoleLogger,
} from '../src/services/email-dispatch'
import { readNotificationRecipient } from '../src/services/notifications'
import { isPublicReference } from '../src/services/public-references'
import type { AppEnv } from '../src/types'

/** Vrai uniquement si l'opérateur a explicitement demandé un envoi réel. */
const ENABLED = process.env.EMAIL_REAL_SEND === '1'

/** Référence publique de la demande déposée pour ce test. */
const REFERENCE = (process.env.EMAIL_REAL_SEND_REFERENCE ?? '').trim()

/**
 * État local de Wrangler, tel que `pnpm dev` l'écrit.
 *
 * Chemin explicite : `wrangler dev` range sa base dans `<dossier>/v3`, alors que
 * l'API programmatique utilise le dossier reçu tel quel. Les deux doivent désigner le
 * même état, sinon ce test lirait une file vide — et donnerait une fausse impression
 * de calme au lieu de dire qu'il n'y a rien à envoyer.
 */
const PERSIST_PATH = '.wrangler/state/v3'

/** Adresse masquée : de quoi reconnaître la boîte sans l'écrire dans un journal. */
function maskEmail(address: string): string {
  const at = address.indexOf('@')
  if (at <= 0) {
    return '***'
  }
  return `${address.slice(0, 1)}***${address.slice(at)}`
}

/** Entrées de la file locale, pour vérifier qu'aucune autre n'a bougé. */
type OutboxSnapshotRow = { id: number; status: string; attempts: number }

async function snapshotOutbox(
  db: AppEnv['Bindings']['DB'],
): Promise<OutboxSnapshotRow[]> {
  const result = await db
    .prepare(`SELECT id, status, attempts FROM email_outbox ORDER BY id`)
    .all<OutboxSnapshotRow>()
  return result.results ?? []
}

describe.skipIf(!ENABLED)(
  'envoi réel : une notification, désignée par sa référence',
  () => {
    it('envoie cette notification-là, et laisse toutes les autres intactes', async () => {
      // 1. La base : locale, et rien d'autre. `getPlatformProxy` lit le dossier de
      //    persistance ci-dessus et ne connaît aucune base distante.
      const proxy = await getPlatformProxy({
        configPath: 'wrangler.jsonc',
        persist: { path: PERSIST_PATH },
      })

      try {
        const env = proxy.env as unknown as AppEnv['Bindings']

        // Garde-fou de ceinture et de bretelles : jamais depuis un environnement de
        // production, même si un `.dev.vars` de production a été copié par erreur.
        const environment = (env.ENVIRONMENT ?? '').trim()
        if (environment === 'production') {
          throw new Error(
            'ENVIRONMENT=production : ce test n’écrit que dans la base locale de développement',
          )
        }
        console.log(
          `[email] base locale : ${PERSIST_PATH} (aucune ressource distante)`,
        )

        // 2. La cible est OBLIGATOIRE, et doit avoir la forme d'une référence
        //    publique : aucune exécution ne peut « envoyer tout ce qui attend ».
        if (REFERENCE === '') {
          throw new Error(
            'EMAIL_REAL_SEND_REFERENCE est requis : indiquez la référence affichée à la fin du formulaire',
          )
        }
        if (
          !isPublicReference(REFERENCE, 'DEV') &&
          !isPublicReference(REFERENCE, 'MSG')
        ) {
          throw new Error(
            `référence « ${REFERENCE} » : forme attendue <TYPE>-<ANNÉE>-<8 caractères>`,
          )
        }

        const target = await findEmailOutboxByReference(env.DB, REFERENCE)
        if (target === null) {
          throw new Error(
            `aucune notification pour la référence ${REFERENCE} dans la base locale`,
          )
        }
        if (target.status === 'sent') {
          throw new Error(
            `${REFERENCE} : notification déjà ACCEPTÉE par le fournisseur (rien à renvoyer)`,
          )
        }
        if (target.status !== 'pending') {
          throw new Error(
            `${REFERENCE} : notification en état « ${target.status} », pas « pending »`,
          )
        }

        // 3. Destinataire et expéditeur : conformité à la configuration de test,
        //    vérifiée AVANT l'envoi. Seules des formes masquées sont affichées.
        const expectedRecipient = readNotificationRecipient(env)
        expect(target.recipient).toBe(expectedRecipient)
        const sender = readEmailSender(env)
        expect(sender.from).toBe(
          (env.EMAIL_FROM_ADDRESS ?? '').trim().toLowerCase(),
        )
        console.log(
          `[email] référence : ${REFERENCE} — notification #${String(target.id)}, ${String(target.attempts)} essai(s)`,
        )
        console.log(`[email] destinataire : ${maskEmail(target.recipient)}`)
        console.log(
          `[email] expéditeur : ${sender.from} (fournisseur « ${(env.EMAIL_PROVIDER ?? '').trim()} »)`,
        )

        const before = await snapshotOutbox(env.DB)

        // 4. Envoi de CETTE entrée, par le même chemin que le traitement planifié.
        const outcome = await dispatchOneEmail({
          db: env.DB,
          provider: sender.provider,
          emailId: target.id,
          now: nowSeconds(),
          log: emailDispatchConsoleLogger,
        })
        console.log(`[email] issue : ${JSON.stringify(outcome)}`)

        // Une prise refusée signifie que rien n'a été envoyé : c'est un échec du
        // test, jamais un envoi silencieux.
        expect(outcome.claimed).toBe(true)
        expect(outcome.status).toBe('sent')

        // 5. Aucune autre entrée n'a été touchée : toutes celles qui étaient dans la
        //    file le sont encore, avec le même état et le même nombre d'essais. C'est
        //    la vérification que ce test n'envoie pas « les anciennes demandes ».
        const after = await snapshotOutbox(env.DB)
        for (const row of before) {
          if (row.id === target.id) {
            continue
          }
          const same = after.find((entry) => entry.id === row.id)
          expect(
            `${String(row.id)}:${same?.status ?? 'absente'}:${String(same?.attempts)}`,
          ).toBe(`${String(row.id)}:${row.status}:${String(row.attempts)}`)
        }

        console.log(
          '[email] la ligne `sent` atteste que Resend a ACCEPTÉ le message.',
        )
        console.log(
          '[email] elle ne prouve pas la réception : vérifiez la boîte (courrier indésirable compris).',
        )
      } finally {
        await proxy.dispose()
      }
    })
  },
)
