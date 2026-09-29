/**
 * Primitives cryptographiques et aléatoires.
 *
 * Ce module ne réimplémente AUCUN algorithme : il s'appuie uniquement sur l'API
 * Web Crypto (`crypto.subtle`, `crypto.getRandomValues`), disponible dans le
 * moteur d'exécution des Workers et dans Node ≥ 22. Aucune dépendance externe,
 * aucun générateur écrit à la main.
 *
 * Usage dans la V1 :
 *   * `hmacSha256Hex` : empreintes des cibles de limitation d'abus (adresse IP,
 *     adresse électronique, téléphone) et clés de limitation, avec un secret
 *     d'environnement. Aucune de ces valeurs n'est stockée en clair ;
 *   * `sha256Hex` : empreinte des jetons de session (jamais le jeton lui-même) ;
 *   * `randomHex` : jetons, clés d'idempotence ;
 *   * `randomString` : références publiques de demande.
 */

/**
 * Alphabet des références publiques : 32 caractères, sans I, L, O ni U.
 *
 * L'objectif est d'éviter les confusions de saisie au téléphone ou à l'oral
 * (I/1, O/0). La taille de l'alphabet (32) divise 256 : tirer un octet puis
 * prendre le reste modulo 32 ne crée donc aucun biais de distribution.
 */
export const PUBLIC_REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Convertit un tampon binaire en chaîne hexadécimale minuscule. */
function toHex(buffer: ArrayBuffer): string {
  let hex = ''
  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Chaîne hexadécimale aléatoire cryptographiquement sûre.
 *
 * Utilisée pour les jetons de session et les clés d'idempotence. 32 octets
 * (valeur par défaut) donnent une empreinte de 64 caractères, conforme aux
 * contraintes du schéma (`length = 64`, hexadécimal minuscule).
 */
export function randomHex(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw new RangeError('byteLength doit être un entier entre 16 et 64')
  }
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toHex(bytes.buffer)
}

/**
 * Chaîne aléatoire dans un alphabet de 32 caractères.
 *
 * Sans biais : 256 est un multiple exact de 32. `length` doit rester dans des
 * bornes raisonnables (une référence publique fait 8 caractères).
 */
export function randomString(
  length: number,
  alphabet: string = PUBLIC_REFERENCE_ALPHABET,
): string {
  if (!Number.isInteger(length) || length < 1 || length > 64) {
    throw new RangeError('length doit être un entier entre 1 et 64')
  }
  if (alphabet.length !== 32) {
    throw new RangeError("l'alphabet doit contenir exactement 32 caractères")
  }
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let value = ''
  for (const byte of bytes) {
    value += alphabet[byte % alphabet.length]
  }
  return value
}

/** Empreinte SHA-256 hexadécimale d'une chaîne (encodage UTF-8). */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return toHex(digest)
}

/**
 * Empreinte HMAC-SHA-256 hexadécimale.
 *
 * Le secret n'est jamais une constante du code : il provient de l'environnement
 * du Worker (variable secrète), afin de pouvoir être renouvelé sans redéploiement
 * de code. C'est ce qui empêche la comparaison hors ligne d'un numéro haché
 * (espaces de recherche trop petits pour un simple SHA-256).
 */
export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  )
  return toHex(signature)
}

/**
 * Comparaison à temps constant de deux empreintes hexadécimales.
 *
 * Le runtime Workers n'expose pas d'équivalent de `timingSafeEqual` : la
 * comparaison est donc faite par accumulation bit à bit, sans sortie anticipée.
 * Seule la LONGUEUR peut influencer la durée, et elle n'est pas secrète : les deux
 * valeurs comparées sont toujours des empreintes HMAC-SHA-256 de 64 caractères, et
 * les appelants vérifient le format avant d'arriver ici. Une comparaison `===`
 * classique s'arrête au premier caractère différent : elle laisserait fuir, par la
 * durée de la réponse, le préfixe commun entre l'empreinte essayée et celle
 * attendue.
 */
export function timingSafeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length || left.length === 0) {
    return false
  }

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}
