/**
 * Erreurs de base de données et traduction des échecs SQLite.
 *
 * Principe de sécurité : rien de ce qui vient de SQL ne doit atteindre un client.
 * Les messages d'erreur SQLite peuvent contenir des noms de colonnes, des
 * expressions de contraintes, voire des fragments de requête. Toute erreur
 * remontée par D1 est donc convertie ici en un code de domaine fermé, associé à
 * un message générique fixe.
 *
 * Deux niveaux sont distingués :
 *   * `message` : message générique sûr, destiné à être journalisé ou traduit par
 *     la couche HTTP (jamais construit à partir de valeurs client) ;
 *   * `diagnostic` : identité technique de la contrainte, extraite par liste
 *     blanche (« unique:quote_requests.phone_normalized »), utile au support et
 *     aux journaux internes. Elle ne peut pas contenir une valeur liée, car seule
 *     une forme reconnue est conservée ; toute autre erreur devient « unknown ».
 *
 * ATTENTION (couche service) : certains codes sont parlants pour un utilisateur
 * (« une demande active existe déjà pour ce numéro »). Une route publique ne doit
 * PAS relayer ce message tel quel : il permettrait de découvrir l'existence d'une
 * demande pour un numéro donné. La neutralisation du message appartient à la
 * couche service, jamais à la couche base.
 */

/** Codes d'échec exposés au reste de l'application. Liste volontairement fermée. */
export type DbFailureCode =
  | 'quote_already_active'
  | 'quote_reference_conflict'
  | 'quote_status_transition_refused'
  | 'quote_not_found'
  | 'contact_reference_conflict'
  | 'contact_message_not_found'
  | 'idempotency_key_reused'
  | 'invalid_password_hash'
  | 'invalid_input'
  | 'db_unavailable'

/** Messages génériques : aucune donnée client, aucun détail SQL. */
const PUBLIC_MESSAGES: Record<DbFailureCode, string> = {
  quote_already_active:
    'Une demande est déjà enregistrée pour ce numéro de téléphone.',
  quote_reference_conflict:
    'La référence de demande générée est déjà utilisée.',
  quote_status_transition_refused:
    "Cette demande ne peut pas changer d'état dans sa situation actuelle.",
  quote_not_found: "Cette demande n'existe pas.",
  contact_reference_conflict:
    'La référence de message générée est déjà utilisée.',
  contact_message_not_found: "Ce message n'existe pas.",
  idempotency_key_reused: 'Cette demande a déjà été enregistrée.',
  invalid_password_hash:
    "Le format de l'empreinte de mot de passe est invalide.",
  invalid_input:
    'Les données transmises ne respectent pas les règles attendues.',
  db_unavailable: 'Le service est momentanément indisponible.',
}

/** Erreur de domaine produite par la couche base de données. */
export class DbError extends Error {
  readonly code: DbFailureCode

  /** Identité technique de la contrainte, sans aucune valeur liée. */
  readonly diagnostic: string

  constructor(code: DbFailureCode, diagnostic = 'unknown') {
    super(PUBLIC_MESSAGES[code])
    this.name = 'DbError'
    this.code = code
    this.diagnostic = diagnostic
  }
}

/**
 * Extrait l'identité d'une contrainte par liste blanche.
 *
 * Seules les formes attendues sont conservées : jeton de déclencheur M3Design,
 * couple « contrainte:table.colonne », ou nom de table manquante. Tout le reste
 * devient « unknown », ce qui garantit qu'aucune valeur liée (numéro, adresse
 * électronique, description) ne peut se retrouver dans un message d'erreur.
 */
function sanitizeDiagnostic(rawMessage: string): string {
  const triggerToken = /M3DESIGN_CONSTRAINT_([A-Z_]+)/.exec(rawMessage)
  if (triggerToken) {
    return `trigger:${triggerToken[1].toLowerCase()}`
  }

  const constraint =
    /(UNIQUE|CHECK|NOT NULL|FOREIGN KEY|PRIMARY KEY) constraint failed:?\s?([A-Za-z0-9_.]*)/.exec(
      rawMessage,
    )
  if (constraint) {
    return `${constraint[1].toLowerCase().replace(/ /g, '_')}:${constraint[2] || 'unnamed'}`
  }

  const missingTable = /no such table: ([A-Za-z0-9_]+)/.exec(rawMessage)
  if (missingTable) {
    return `no_such_table:${missingTable[1]}`
  }

  return 'unknown'
}

/** Traduit un échec SQLite en code de domaine. */
function codeFor(rawMessage: string): DbFailureCode {
  if (/constraint failed: quote_requests\.phone_normalized/.test(rawMessage)) {
    return 'quote_already_active'
  }
  if (/constraint failed: quote_requests\.reference/.test(rawMessage)) {
    return 'quote_reference_conflict'
  }
  if (/constraint failed: contact_messages\.reference/.test(rawMessage)) {
    return 'contact_reference_conflict'
  }
  if (
    /constraint failed: (quote_requests|contact_messages)\.idempotency_key/.test(
      rawMessage,
    )
  ) {
    return 'idempotency_key_reused'
  }
  if (
    /constraint failed: (users|sessions|request_events|email_outbox|contact_messages)\./.test(
      rawMessage,
    ) ||
    /CHECK constraint failed|NOT NULL constraint failed|FOREIGN KEY constraint failed/.test(
      rawMessage,
    )
  ) {
    return 'invalid_input'
  }
  return 'db_unavailable'
}

/** Convertit n'importe quel échec en `DbError`, sans jamais recopier le SQL. */
export function toDbError(error: unknown): DbError {
  if (error instanceof DbError) {
    return error
  }
  const rawMessage = error instanceof Error ? error.message : ''
  return new DbError(codeFor(rawMessage), sanitizeDiagnostic(rawMessage))
}

/**
 * Lit le nombre de lignes réellement modifiées par une instruction.
 *
 * D1 renvoie ces métadonnées pour chaque instruction d'un lot : c'est ce qui
 * permet d'écrire des mises à jour conditionnelles fiables (deux écritures
 * concurrentes ne peuvent pas « gagner » toutes les deux).
 */
export function changedRows(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes
  return typeof changes === 'number' ? changes : 0
}
