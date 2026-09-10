// lib/currencyRegistry.ts
//
// Centralized Currency Registry — the single source of truth for currency
// data across the P2P module. Every screen reads from CURRENCY_REGISTRY (or
// the helper functions below) rather than keeping its own copy — the
// previous version had CURRENCIES defined once in p2pService.ts, which was
// fine as long as nothing else needed currency data; this exists as its own
// module now specifically so it's unambiguous where the one source of truth
// lives as the feature grows (exchange rates, merchant pricing, etc. all
// need the exact same currency list).

export interface CurrencyEntry {
  code: string       // ISO 4217-style code (some, like nothing here, are genuinely non-ISO — all 21 are real codes)
  symbol: string
  name: string
  flag: string        // emoji flag — representative country, not a claim of exclusivity (EUR/CHF etc. span multiple countries)
  decimals: number     // standard minor-unit decimals for this currency (JPY/IDR use 0, most use 2)
}

export const CURRENCY_REGISTRY: CurrencyEntry[] = [
  { code: 'USD', symbol: '$',   name: 'US Dollar',            flag: '🇺🇸', decimals: 2 },
  { code: 'EUR', symbol: '€',   name: 'Euro',                 flag: '🇪🇺', decimals: 2 },
  { code: 'GBP', symbol: '£',   name: 'British Pound',        flag: '🇬🇧', decimals: 2 },
  { code: 'INR', symbol: '₹',   name: 'Indian Rupee',         flag: '🇮🇳', decimals: 2 },
  { code: 'PKR', symbol: '₨',   name: 'Pakistani Rupee',      flag: '🇵🇰', decimals: 2 },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham',           flag: '🇦🇪', decimals: 2 },
  { code: 'SAR', symbol: '﷼',   name: 'Saudi Riyal',          flag: '🇸🇦', decimals: 2 },
  { code: 'JPY', symbol: '¥',   name: 'Japanese Yen',         flag: '🇯🇵', decimals: 0 },
  { code: 'CNY', symbol: '¥',   name: 'Chinese Yuan',         flag: '🇨🇳', decimals: 2 },
  { code: 'SGD', symbol: 'S$',  name: 'Singapore Dollar',     flag: '🇸🇬', decimals: 2 },
  { code: 'AUD', symbol: 'A$',  name: 'Australian Dollar',    flag: '🇦🇺', decimals: 2 },
  { code: 'CAD', symbol: 'C$',  name: 'Canadian Dollar',      flag: '🇨🇦', decimals: 2 },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc',          flag: '🇨🇭', decimals: 2 },
  { code: 'TRY', symbol: '₺',   name: 'Turkish Lira',         flag: '🇹🇷', decimals: 2 },
  { code: 'BRL', symbol: 'R$',  name: 'Brazilian Real',       flag: '🇧🇷', decimals: 2 },
  { code: 'NGN', symbol: '₦',   name: 'Nigerian Naira',       flag: '🇳🇬', decimals: 2 },
  { code: 'ZAR', symbol: 'R',   name: 'South African Rand',   flag: '🇿🇦', decimals: 2 },
  { code: 'PHP', symbol: '₱',   name: 'Philippine Peso',      flag: '🇵🇭', decimals: 2 },
  { code: 'MYR', symbol: 'RM',  name: 'Malaysian Ringgit',    flag: '🇲🇾', decimals: 2 },
  { code: 'THB', symbol: '฿',   name: 'Thai Baht',            flag: '🇹🇭', decimals: 2 },
  { code: 'IDR', symbol: 'Rp',  name: 'Indonesian Rupiah',    flag: '🇮🇩', decimals: 0 },
]

const BY_CODE = new Map(CURRENCY_REGISTRY.map(c => [c.code, c]))

export function getCurrency(code: string): CurrencyEntry {
  return BY_CODE.get(code) ?? { code, symbol: code, name: code, flag: '🏳️', decimals: 2 }
}

export function currencySymbol(code: string): string {
  return getCurrency(code).symbol
}

export function formatFiat(amount: number, code: string): string {
  const c = getCurrency(code)
  return `${c.symbol}${amount.toLocaleString(undefined, { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals })}`
}
