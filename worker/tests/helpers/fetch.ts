/**
 * Espion de `fetch` pour les tests de fournisseurs externes.
 *
 * Les fournisseurs injectent leur `fetch` : un test peut donc vérifier EXACTEMENT
 * ce qui serait transmis (URL, en-têtes, corps) et répondre ce qu'il veut, sans
 * jamais ouvrir de socket. C'est ce qui permet d'affirmer qu'un jeton ne vit que
 * dans l'en-tête `Authorization`, et qu'une réponse d'erreur du fournisseur ne
 * ressort pas dans un message public.
 *
 * Les en-têtes sont aplatis en objet simple et en minuscules : c'est la forme sous
 * laquelle ils sont réellement transmis.
 */

/** Appel reçu par la `fetch` injectée. */
export type FetchCall = {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export type FetchSpy = {
  calls: readonly FetchCall[]
  fetchImplementation: typeof fetch
}

/** Remplace `fetch` par un espion qui enregistre l'appel et répond. */
export function createFetchSpy(
  responder: (call: FetchCall) => Response | Promise<Response>,
): FetchSpy {
  const calls: FetchCall[] = []
  const fetchImplementation = (async (
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[name.toLowerCase()] = value
    }
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    }
    calls.push(call)
    return responder(call)
  }) as typeof fetch
  return { calls, fetchImplementation }
}
