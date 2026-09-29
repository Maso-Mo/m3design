/**
 * Tests des fonctions pures de la couche service : références publiques et
 * normalisation des numéros.
 *
 * Ces deux fonctions portent des garanties fortes et sans base de données :
 *   * une référence doit rester dictable au téléphone (pas de I, L, O, U) et
 *     improbable à deviner ;
 *   * deux mises en forme du même numéro doivent donner la MÊME forme normalisée,
 *     sans quoi l'unicité « une demande active par numéro » serait contournable en
 *     changeant les espaces ou en écrivant « 00 » au lieu de « + ».
 *
 * Aucun accès réseau, aucune base : ce fichier s'exécute en quelques millisecondes.
 */

import { describe, expect, it } from 'vitest'
import { maskPhoneNumber, normalizePhoneNumber } from '../src/services/phone'
import {
  generateQuoteReference,
  isQuoteReference,
  QUOTE_REFERENCE_PREFIX,
  QUOTE_REFERENCE_RANDOM_LENGTH,
} from '../src/services/quote-reference'

describe('référence publique d’une demande', () => {
  it('génère une référence dictable, sans caractère ambigu', () => {
    // Source aléatoire injectée : le test est reproductible.
    expect(
      generateQuoteReference({ year: 2027, random: () => 'ABCD2345' }),
    ).toBe('DEV-2027-ABCD2345')
    expect(QUOTE_REFERENCE_PREFIX).toBe('DEV')
    expect(QUOTE_REFERENCE_RANDOM_LENGTH).toBe(8)

    // Avec la source réelle : format stable et alphabet sans I, L, O ni U, qui
    // sont les caractères confondus à l'oral (I/1, O/0, L/1).
    const references = new Set<string>()
    for (let index = 0; index < 200; index += 1) {
      const reference = generateQuoteReference({ year: 2027 })
      expect(reference).toMatch(/^DEV-2027-[0-9A-HJKMNP-TV-Z]{8}$/)
      expect(reference).not.toMatch(/[ILOU]/)
      expect(isQuoteReference(reference)).toBe(true)
      references.add(reference)
    }
    // 8 caractères sur un alphabet de 32 : une collision sur 200 tirages serait
    // l'indice d'une source aléatoire défaillante.
    expect(references.size).toBe(200)
  })

  it('refuse une année qui n’est pas un entier à quatre chiffres', () => {
    expect(() => generateQuoteReference({ year: 1999 })).toThrow(RangeError)
    expect(() => generateQuoteReference({ year: 10_000 })).toThrow(RangeError)
    expect(() => generateQuoteReference({ year: 2027.5 })).toThrow(RangeError)
    expect(() => generateQuoteReference({ year: Number.NaN })).toThrow(
      RangeError,
    )
  })

  it('valide strictement le format attendu', () => {
    expect(isQuoteReference('DEV-2027-ABCD2345')).toBe(true)
    // Un caractère ambigu ne passe pas : la référence doit être recopiable à l'oral.
    expect(isQuoteReference('DEV-2027-ABCD234I')).toBe(false)
    expect(isQuoteReference('DEV-2027-ELEU2345')).toBe(false)
    // Longueur, casse, année et séparateurs sont exacts.
    expect(isQuoteReference('DEV-2027-ABCD234')).toBe(false)
    expect(isQuoteReference('DEV-2027-ABCD23456')).toBe(false)
    expect(isQuoteReference('dev-2027-ABCD2345')).toBe(false)
    expect(isQuoteReference('DEV-27-ABCD2345')).toBe(false)
    expect(isQuoteReference('DEV-2027-ABCD 345')).toBe(false)
    expect(isQuoteReference('DEV-2027-ABCD2345 ')).toBe(false)
    expect(isQuoteReference('')).toBe(false)
    // Un numéro de téléphone n'est évidemment pas une référence.
    expect(isQuoteReference('+261341234567')).toBe(false)
  })
})

describe('normalisation d’un numéro de téléphone', () => {
  it('ramène les mises en forme équivalentes du même numéro à une seule forme', () => {
    // Toutes ces saisies désignent le même abonné : elles DOIVENT devenir égales,
    // sinon l'unicité par numéro serait contournable par simple changement de
    // mise en forme.
    const variants = [
      '+261 34 12 345 67',
      '00261341234567',
      '+261.34.12.345.67',
      '(+261) 34/12-345-67',
      '+26134123456 7',
      ' +261\u00A034\u202F12\u00A0345\u00A067 ',
    ]
    const normalized = variants.map((variant) => normalizePhoneNumber(variant))
    for (const result of normalized) {
      expect(result).toEqual({ ok: true, normalized: '+261341234567' })
    }

    // Un numéro national sans indicatif n'est jamais deviné : aucun pays par défaut.
    expect(normalizePhoneNumber('034 12 345 67')).toEqual({
      ok: false,
      reason: 'missing_country_code',
    })
    expect(normalizePhoneNumber('00261341234567 ')).toEqual({
      ok: true,
      normalized: '+261341234567',
    })
  })

  it('refuse un numéro sans indicatif, mal dimensionné ou non numérique', () => {
    expect(normalizePhoneNumber('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizePhoneNumber('   ')).toEqual({ ok: false, reason: 'empty' })
    // Au-delà de la longueur maximale d'une saisie, la valeur n'est même pas lue
    // comme un numéro : elle est traitée comme une saisie inutilisable.
    expect(normalizePhoneNumber('+2'.repeat(20))).toEqual({
      ok: false,
      reason: 'empty',
    })

    // Un indicatif E.164 ne commence jamais par 0 : « +0… » est un numéro local mal
    // signalé, donc refusé comme un oubli d'indicatif.
    expect(normalizePhoneNumber('+0123456789')).toEqual({
      ok: false,
      reason: 'missing_country_code',
    })
    expect(normalizePhoneNumber('+261 34 12')).toEqual({
      ok: false,
      reason: 'invalid_length',
    })
    expect(normalizePhoneNumber('+2613412345678901')).toEqual({
      ok: false,
      reason: 'invalid_length',
    })
    expect(normalizePhoneNumber('+261 34 A2 345 67')).toEqual({
      ok: false,
      reason: 'invalid_characters',
    })
    expect(normalizePhoneNumber('+261_341234567')).toEqual({
      ok: false,
      reason: 'invalid_characters',
    })
  })

  it('accepte les bornes de longueur de l’E.164', () => {
    // Huit chiffres : la plus courte longueur acceptée (indicatif pays compris).
    expect(normalizePhoneNumber('+26134123')).toEqual({
      ok: true,
      normalized: '+26134123',
    })
    // Quinze chiffres : la longueur maximale d'un numéro E.164.
    expect(normalizePhoneNumber('+123456789012345')).toEqual({
      ok: true,
      normalized: '+123456789012345',
    })
  })
})

describe('masquage d’un numéro pour les journaux', () => {
  it('laisse reconnaître un appelant sans permettre de le rappeler', () => {
    const masked = maskPhoneNumber('+261341234567')

    expect(masked).toBe('+2613••••••67')
    // Un numéro complet ne doit jamais apparaître dans une ligne de journal.
    expect(masked).not.toContain('261341234567')
    // Deux appels du même abonné restent comparables entre eux.
    expect(maskPhoneNumber('+261 34 12 345 67')).toBe(masked)
    // Un autre abonné produit un autre masque.
    expect(maskPhoneNumber('+261349999999')).not.toBe(masked)
  })

  it('ne laisse rien filtrer d’un numéro trop court', () => {
    expect(maskPhoneNumber('123')).toBe('•••')
    expect(maskPhoneNumber('123456')).toBe('••••••')
    expect(maskPhoneNumber('')).toBe('•••')
  })
})
