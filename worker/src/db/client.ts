/**
 * Socle d'accès à la base D1.
 *
 * Ce module ne contient volontairement AUCUNE logique métier : il expose le type
 * de la base et des utilitaires transverses (temps, bornage des lots). Les
 * requêtes SQL vivent dans `worker/src/db/repositories/`, les règles métier dans
 * `worker/src/services/`, et les routes HTTP dans `worker/src/routes/`.
 *
 * Règles d'écriture appliquées partout dans les dépôts :
 *   * toute valeur venant d'un client passe par une requête préparée et liée
 *     (`.prepare(...).bind(...)`) : aucune concaténation de SQL ;
 *   * un échec de contrainte est traduit en erreur de domaine générique
 *     (`worker/src/db/errors.ts`) : ni le SQL, ni les valeurs liées ne remontent
 *     au client ou dans les journaux ;
 *   * D1 n'offre pas de transaction interactive : les écritures qui doivent
 *     réussir ensemble passent par `db.batch([...])`, qui exécute les instructions
 *     dans une seule transaction (vérifié sur la base locale : un échec annule
 *     toutes les instructions du lot).
 */

/** Type de la base D1, tel que généré par `wrangler types` (binding `DB`). */
export type Db = D1Database

/**
 * Horodatage courant en secondes Unix.
 *
 * Toutes les dates du schéma sont des entiers de secondes Unix (`unixepoch()`),
 * ce qui évite toute ambiguïté de fuseau horaire dans les comparaisons et les
 * index.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Borne une taille de lot demandée par l'appelant.
 *
 * Les traitements de purge et les listes sont paginés : sans borne haute, un
 * appelant pourrait demander une écriture massive. La valeur est donc bornée
 * avant d'atteindre SQL.
 */
export function clampLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(Math.max(Math.floor(value), 1), maximum)
}
