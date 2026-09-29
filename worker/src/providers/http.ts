/**
 * Petits utilitaires HTTP partagés par les fournisseurs externes.
 *
 * Ils existent pour éviter que chaque fournisseur réinvente — et finisse par
 * assouplir — les mêmes règles de lecture d'une réponse : un corps illisible n'est
 * jamais une exception, un délai annoncé par le fournisseur est borné, et aucune
 * donnée de la réponse n'est recopiée dans un message d'erreur.
 *
 * Aucune de ces fonctions ne journalise quoi que ce soit : ce qui sort d'un
 * fournisseur peut contenir l'adresse du destinataire ou le contenu du message, et
 * c'est à la couche service de décider ce qui est consigné.
 */

/** Entier positif court, tel qu'attendu dans un en-tête HTTP technique. */
export const INTEGER_PATTERN = /^[0-9]{1,6}$/

/**
 * Lit l'en-tête `Retry-After` (secondes), borné, sans jamais lever.
 *
 * Seule la forme en secondes est interprétée : la forme « date HTTP » existe mais
 * suppose une horloge synchronisée avec celle du fournisseur, et une date mal
 * interprétée vaut mieux ignorée qu'utilisée pour repousser un envoi à une date
 * arbitraire.
 */
export function readRetryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null || !INTEGER_PATTERN.test(raw.trim())) {
    return undefined
  }
  const seconds = Number(raw.trim())
  return seconds >= 1 && seconds <= 3600 ? seconds : undefined
}

/**
 * Un rejet de `fetch` vient-il d'une annulation, donc d'un délai dépassé ?
 *
 * Le runtime Workers lève un `TimeoutError` (ou un `AbortError` selon le chemin) :
 * les deux sont reconnus, et distinguer un délai d'une panne réseau évite de
 * réessayer au même rythme dans les deux cas.
 */
export function isAbortFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const name = (error as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * Lit un corps de réponse en JSON, sans jamais lever.
 *
 * Un corps vide, tronqué ou en HTML (page d'erreur d'un intermédiaire réseau)
 * devient `null` : seul l'état HTTP reste alors exploitable, ce qui suffit à
 * décider de la suite. La réponse brute n'est jamais conservée plus loin.
 */
export async function readJsonPayload(response: Response): Promise<unknown> {
  try {
    const text = await response.text()
    return text === '' ? null : JSON.parse(text)
  } catch {
    return null
  }
}
