/**
 * Champs annexes communs aux deux opérations publiques — demande de devis et
 * message de contact — et bornes de texte alignées sur les contraintes du schéma.
 *
 * Pourquoi un module partagé : les deux formulaires acceptent EXACTEMENT les mêmes
 * champs annexes (forme brute du numéro, nom, adresse électronique, clé
 * d'idempotence) et les mêmes bornes de texte (10 à 2000 caractères). Deux copies
 * de ces règles finiraient par diverger, et la divergence ne se verrait qu'en
 * production, sous la forme d'un refus de la base que le client ne peut pas
 * comprendre. Une seule règle, un seul endroit.
 *
/**
 * Ce module est PUR : aucun accès à la base, aucun appel réseau, aucune lecture
 * d'environnement. Il ne décide pas non plus de ce qui est facultatif — chaque
 * service garde la main sur son formulaire et sur la façon dont il présente un
 * refus.
 */

import { randomHex } from '../lib/crypto'
import { normalizePhoneNumber } from './phone'

/** Bornes du texte principal : description d'un devis, message de contact. */
export const MIN_TEXT_LENGTH = 10
export const MAX_TEXT_LENGTH = 2000

/** Bornes d'un nom de contact (`ck_quote_contact_name`, `ck_contact_contact_name`). */
export const MAX_CONTACT_NAME_LENGTH = 120

/** Bornes de la clé d'idempotence, communes aux deux tables. */
export const MIN_IDEMPOTENCY_KEY_LENGTH = 16
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128

/** Bornes de la forme brute d'un numéro, telle que saisie par le client. */
export const MIN_PHONE_RAW_LENGTH = 6
export const MAX_PHONE_RAW_LENGTH = 32

/** Bornes d'une adresse électronique, alignées sur les contraintes du schéma. */
export const MIN_EMAIL_LENGTH = 6
export const MAX_EMAIL_LENGTH = 254

/**
 * Longueur d'un texte telle que SQLite la compte : des POINTS DE CODE.
 *
 * `String.length` compte les unités UTF-16, donc un caractère hors du plan de base
 * (un émoji, par exemple) y vaut 2. S'en servir pour valider ferait diverger la
 * règle applicative de la contrainte de la base — tantôt plus stricte, tantôt plus
 * permissive selon la position du caractère. Le parcours par itérateur compte les
 * points de code, exactement comme `length()` de SQLite.
 */
export function textLength(value: string): number {
  return [...value].length
}

/** Vrai si le champ est absent, `null` ou composé uniquement d'espaces. */
export function isBlankText(value: string | null | undefined): boolean {
  return (value ?? '').trim() === ''
}

/**
 * Vrai si un texte principal respecte les bornes du schéma.
 *
 * C'est la seule règle de longueur des deux formulaires : la base refuserait de
 * toute façon un texte hors bornes, mais elle ne peut pas expliquer au client ce
 * qu'il a mal envoyé — d'où un refus applicatif, tôt, avec une raison précise côté
 * journal et un message générique côté client.
 */
export function hasUsableTextLength(value: string): boolean {
  const length = textLength(value)
  return length >= MIN_TEXT_LENGTH && length <= MAX_TEXT_LENGTH
}

/**
 * Vrai si la forme brute d'un numéro a une longueur exploitable.
 *
 * La valeur attendue est déjà NETTOYÉE de ses espaces de bord : c'est la forme que
 * le service conservera pour le rappel téléphonique, telle que saisie.
 */
export function hasUsableRawPhoneLength(trimmedRawPhone: string): boolean {
  const length = textLength(trimmedRawPhone)
  return length >= MIN_PHONE_RAW_LENGTH && length <= MAX_PHONE_RAW_LENGTH
}

/**
 * Motif d'adresse électronique : le strict nécessaire pour que les contraintes du
 * schéma (`lower`, longueur, `LIKE '%_@_%.__%'`) soient toujours satisfaites.
 *
 * Une validation plus fine (RFC 5322) rejetterait des adresses valides sans rien
 * garantir de plus : la seule vérification qui compte est l'envoi d'un message.
 */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^\s@]{2,}$/

/**
 * Normalise une adresse électronique facultative : espaces retirés, minuscules.
 *
 * La mise en minuscules n'est pas une préférence : les deux contraintes de schéma
 * l'exigent (`contact_email = lower(contact_email)`), et « Jean@Exemple.MG »
 * désigne la même boîte que « jean@exemple.mg ». Refuser la casse mixte serait
 * hostile et inutile.
 *
 * Renvoie `null` si la valeur est vide OU invalide : à l'appelant de distinguer
 * les deux cas à l'aide de `isBlankText` — un champ vide est une absence
 * légitime, un champ mal formé est un refus.
 */
export function normalizeContactEmail(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') {
    return null
  }
  const length = textLength(value)
  if (
    length < MIN_EMAIL_LENGTH ||
    length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(value)
  ) {
    return null
  }
  return value
}

/**
 * Normalise un nom de contact. Obligatoire pour les formulaires de la V1 : un nom
 * vide ou hors bornes est refusé (`null`), et c'est le service qui décide du refus.
 */
export function normalizeRequiredContactName(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? '').trim()
  if (value === '') {
    return null
  }
  return textLength(value) <= MAX_CONTACT_NAME_LENGTH ? value : null
}

/**
 * Motif d'un champ « leurre » (pot de miel) : il doit rester VIDE.
 *
 * Pourquoi un tel champ : un visiteur humain ne le voit pas (il est masqué en CSS
 * et retiré de la navigation clavier), tandis qu'un robot qui remplit tous les
 * champs du formulaire le remplit aussi. C'est la protection anti-spam la moins
 * coûteuse et la plus respectueuse : aucun défi, aucun cookie, aucune donnée
 * supplémentaire.
 */
export const HONEYPOT_FIELD = 'website'

/**
 * Champs d'une soumission validés, communs aux deux formulaires.
 *
 * Ce que les deux formulaires ont en commun, c'est exactement cela : un nom et une
 * adresse électronique obligatoires, un téléphone FACULTATIF (jamais vérifié), et
 * une clé d'idempotence optionnelle. Le texte du besoin, lui, reste propre à chaque
 * service (`description` d'un devis, `message` de contact).
 */
export type ValidatedIntakeFields = {
  contactName: string
  contactEmail: string
  phoneNormalized: string | null
  phoneRaw: string | null
  idempotencyKey: string
}

/** Champ refusé, par nom : la couche service en tire un motif de journal. */
export type IntakeFieldRefusal = 'name' | 'email' | 'phone' | 'idempotency_key'

/** Renseigne les valeurs par défaut injectables (tests) de la validation. */
export type ValidateIntakeOptions = {
  /** Source d'aléa pour la clé d'idempotence générée (tests déterministes). */
  randomHex?: (byteLength: number) => string
}

/** Taille de la clé d'idempotence générée par le serveur (16 octets ⇒ 32 signes). */
export const GENERATED_IDEMPOTENCY_KEY_BYTES = 16

/**
 * Valide et normalise les champs communs, ou rend le champ fautif.
 *
 * Le refus porte sur le CHAMP, pas sur un message : chaque service traduit ensuite
 * en motif de journal, et la réponse publique reste volontairement générique (un
 * appelant ne doit pas apprendre lequel de ses champs a été refusé).
 */
export function validateIntakeFields(
  input: {
    name: string
    email: string
    phone: string | null
    idempotencyKey: string | null
  },
  options: ValidateIntakeOptions = {},
):
  | { ok: true; value: ValidatedIntakeFields }
  | { ok: false; field: IntakeFieldRefusal } {
  const contactName = normalizeRequiredContactName(input.name)
  if (contactName === null) {
    return { ok: false, field: 'name' }
  }

  const contactEmail = normalizeContactEmail(input.email)
  if (contactEmail === null) {
    return { ok: false, field: 'email' }
  }

  // Téléphone FACULTATIF : vide ⇒ absent. Renseigné mais inexploitable ⇒ refus, car
  // enregistrer un numéro faux rendrait tout rappel impossible.
  let phoneNormalized: string | null = null
  let phoneRaw: string | null = null
  if (!isBlankText(input.phone)) {
    const raw = (input.phone ?? '').trim()
    if (!hasUsableRawPhoneLength(raw)) {
      return { ok: false, field: 'phone' }
    }
    const normalized = normalizePhoneNumber(raw)
    if (!normalized.ok) {
      return { ok: false, field: 'phone' }
    }
    phoneNormalized = normalized.normalized
    phoneRaw = raw
  }

  const providedKey = (input.idempotencyKey ?? '').trim()
  if (providedKey !== '' && !isValidIdempotencyKey(providedKey)) {
    return { ok: false, field: 'idempotency_key' }
  }

  return {
    ok: true,
    value: {
      contactName,
      contactEmail,
      phoneNormalized,
      phoneRaw,
      idempotencyKey:
        providedKey === ''
          ? `auto-${(options.randomHex ?? randomHex)(
              GENERATED_IDEMPOTENCY_KEY_BYTES,
            )}`
          : providedKey,
    },
  }
}

/**
 * Motif de la clé d'idempotence.
 *
 * Restreindre l'alphabet n'est pas une coquetterie : cette valeur est écrite dans
 * une colonne à index unique et renvoyée à l'appelant. En n'acceptant que des
 * caractères techniques, on garantit qu'aucune donnée personnelle ne peut y être
 * glissée et qu'aucun caractère de contrôle n'entre en base.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** Vrai si la clé d'idempotence fournie par le client est exploitable. */
export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value)
}

/**
 * Vrai si le champ leurre (pot de miel) a été rempli — donc si la soumission est
 * probablement automatisée. Absent ou vide est la situation normale : le visiteur
 * humain ne voit pas ce champ, masqué en CSS.
 */
export function isHoneypotFilled(value: string | null | undefined): boolean {
  return !isBlankText(value)
}
