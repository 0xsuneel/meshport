import { describe, it, expect } from 'vitest'
import { currencyForLocale, localeRegion } from './localCurrency'

describe('local currency', () => {
  it('follows the phone region in any country', () => {
    expect(currencyForLocale('en-US')).toBe('USD')
    expect(currencyForLocale('en-GB')).toBe('GBP')
    expect(currencyForLocale('de-DE')).toBe('EUR')
    expect(currencyForLocale('fr-FR')).toBe('EUR')
    expect(currencyForLocale('en-IN')).toBe('INR')
    expect(currencyForLocale('pt-BR')).toBe('BRL')
    expect(currencyForLocale('ja-JP')).toBe('JPY')
    expect(currencyForLocale('en-NG')).toBe('NGN')
  })
  it('falls back to USD - never to one country', () => {
    expect(currencyForLocale(null)).toBe('USD')
    expect(currencyForLocale('xx-ZZ')).toBe('USD')
  })
  it('reads the region from a locale', () => {
    expect(localeRegion('en_IN')).toBe('IN')
    expect(localeRegion('es-MX')).toBe('MX')
  })
})
