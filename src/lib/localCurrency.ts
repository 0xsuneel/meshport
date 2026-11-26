// The business's local currency, for things priced in cash (cash out to a
// bank, the CSV export's local-money columns). MeshPort is used in every
// country, so nothing assumes one: the phone's region picks it (en-GB → GBP,
// de-DE → EUR, en-IN → INR …), the business can change it, and anything we
// can't place falls back to USD.

const KEY = 'meshport_business_currency'

// Region (ISO 3166) → currency (ISO 4217). Euro area listed as a group.
const EURO = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' ')
const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', IN: 'INR', PK: 'PKR', AE: 'AED', SA: 'SAR', JP: 'JPY', CN: 'CNY', SG: 'SGD',
  AU: 'AUD', CA: 'CAD', CH: 'CHF', TR: 'TRY', BR: 'BRL', NG: 'NGN', ZA: 'ZAR', PH: 'PHP', MY: 'MYR',
  TH: 'THB', ID: 'IDR', BD: 'BDT', LK: 'LKR', NP: 'NPR', KE: 'KES', GH: 'GHS', EG: 'EGP', MA: 'MAD',
  MX: 'MXN', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', KR: 'KRW', TW: 'TWD', HK: 'HKD', VN: 'VND',
  NZ: 'NZD', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', IL: 'ILS',
  QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR', JO: 'JOD', UA: 'UAH', RU: 'RUB', TZ: 'TZS', UG: 'UGX',
  ...Object.fromEntries(EURO.map(r => [r, 'EUR'])),
}

/** The region of a BCP 47 locale ("en-IN" → "IN"), or null. */
export function localeRegion(locale: string | undefined | null): string | null {
  if (!locale) return null
  try {
    const r = new Intl.Locale(locale).maximize().region
    return r ? r.toUpperCase() : null
  } catch {
    const m = /[-_]([A-Za-z]{2})\b/.exec(locale)
    return m ? m[1].toUpperCase() : null
  }
}

/** Currency for a locale; USD when the region isn't known. */
export function currencyForLocale(locale: string | undefined | null): string {
  const r = localeRegion(locale)
  return (r && REGION_CURRENCY[r]) || 'USD'
}

/** This business's local currency: its own choice, else the phone's region. */
export function businessCurrency(): string {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && /^[A-Z]{3}$/.test(saved)) return saved
  } catch { /* storage unavailable */ }
  return currencyForLocale(typeof navigator !== 'undefined' ? (navigator.languages?.[0] || navigator.language) : null)
}

export function setBusinessCurrency(code: string): void {
  try { localStorage.setItem(KEY, code.toUpperCase()) } catch { /* storage unavailable */ }
}

/** The phone's time zone (IANA, e.g. "Europe/London"); UTC when unknown. */
export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}
