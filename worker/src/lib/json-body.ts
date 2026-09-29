/**
 * Lecture stricte du corps JSON d'une requête.
 *
 * Pourquoi un module dédié plutôt que `await c.req.json()` dans chaque route :
 *
 *   * `c.req.json()` lève une exception sur un corps vide, tronqué ou non JSON.
 *     Une exception non rattrapée remonterait au gestionnaire d'erreurs global et
 *     se transformerait en `500 internal_error` : une entrée invalide serait donc
 *     signalée comme une panne du serveur, ce qui fausse la supervision et laisse
 *     croire à un incident ;
 *   * un corps de taille illimitée est accepté d'emblée par le runtime : une
 *     requête de plusieurs mégaoctets serait entièrement lue et analysée avant
 *     que l'application ne sache qu'elle n'en voulait que quelques champs. La
 *     taille est donc bornée AVANT l'analyse ;
 *   * seul un OBJET JSON est accepté : un tableau, un nombre ou une chaîne
 *     n'ont pas de champs, et laisser passer ces formes ferait dépendre le
 *     comportement de la route d'un détail d'analyse JSON.
 *
 * Le module ne connaît aucun nom de champ : l'extraction et la validation des
 * valeurs appartiennent à chaque route, qui sait ce qu'elle attend.
 */

import type { Context } from 'hono'

/** Taille maximale acceptée pour un corps JSON. Aucun formulaire légitime n'approche. */
export const MAX_JSON_BODY_BYTES = 8 * 1024

/** Motif d'un échec de lecture, destiné à être traduit en réponse HTTP. */
export type JsonBodyFailure = 'too_large' | 'unreadable' | 'not_an_object'

export type JsonBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: JsonBodyFailure }

/**
 * Lit le corps de la requête comme un objet JSON, sans jamais lever.
 *
 * L'ordre des contrôles est celui du moindre coût : lecture bornée, analyse,
 * puis forme. Le corps brut n'est jamais recopié dans un message d'erreur — il
 * peut contenir un code de vérification ou une preuve.
 */
export async function readJsonObject(
  c: Context,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<JsonBodyResult> {
  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    // Corps interrompu ou déclaré illisible par l'intermédiaire réseau.
    return { ok: false, reason: 'unreadable' }
  }

  // Mesure en OCTETS (UTF-8) et non en caractères : une suite de caractères
  // accentués ou d'émojis pèse plus lourd qu'elle n'est longue.
  if (new TextEncoder().encode(raw).length > maxBytes) {
    return { ok: false, reason: 'too_large' }
  }
  if (raw.trim() === '') {
    return { ok: false, reason: 'unreadable' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_an_object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/**
 * Lit un champ texte d'un corps JSON.
 *
 * Renvoie `null` si le champ est absent ou s'il n'est pas une chaîne : une route
 * ne doit jamais traiter un objet, un nombre ou un tableau comme du texte. Les
 * champs inutiles sont ignorés sans erreur : un client qui envoie un champ en
 * trop ne doit pas être rejeté, mais ce champ n'atteindra jamais la base.
 */
export function readTextField(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const value = body[field]
  return typeof value === 'string' ? value : null
}

/** Résultat de la lecture d'un champ texte facultatif. */
export type OptionalTextField =
  { ok: true; value: string | null } | { ok: false; reason: 'not_a_string' }

/**
 * Lit un champ texte FACULTATIF d'un corps JSON.
 *
 * Absent ou `null` ⇒ valeur absente : le champ est facultatif, et « null » est la
 * façon habituelle, en JSON, d'exprimer cette absence. Présent mais d'un autre
 * type ⇒ refus, et non silence : ignorer un tableau ou un objet dans un champ de
 * texte ferait dépendre le comportement de la route d'un détail de forme, alors
 * que l'appelant croit avoir transmis une valeur.
 *
 * Une chaîne vide reste une chaîne vide : c'est au service de décider ce qu'il
 * fait d'un champ vide, il n'est pas réécrit ici.
 */
export function readOptionalTextField(
  body: Record<string, unknown>,
  field: string,
): OptionalTextField {
  const value = body[field]
  if (value === undefined || value === null) {
    return { ok: true, value: null }
  }
  if (typeof value !== 'string') {
    return { ok: false, reason: 'not_a_string' }
  }
  return { ok: true, value }
}
