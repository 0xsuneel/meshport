// localeFormat.ts - date/time formatting with a reused Intl formatter.
//
// date.toLocaleTimeString(locale, options) (and toLocaleDateString /
// toLocaleString) builds a brand-new Intl.DateTimeFormat on every call, which
// is far slower than formatting itself. In lists that format once per row on
// every render (chat bubbles, chat list, day separators) that was a large
// share of each render. One formatter per (locale, options), made on first
// use; the output is the same (with explicit date/time fields in `options`,
// toLocale*String(l, o) === new Intl.DateTimeFormat(l, o).format(d)).

const cache = new Map<string, Intl.DateTimeFormat>()

function formatter(locale: string | string[] | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale ?? null, options])
  let f = cache.get(key)
  if (!f) { f = new Intl.DateTimeFormat(locale, options); cache.set(key, f) }
  return f
}

/** Same as date.toLocale{Date,Time,}String(locale, options) - options must name the fields shown. */
export function formatLocale(date: Date, locale: string | string[] | undefined, options: Intl.DateTimeFormatOptions): string {
  // toLocale*String returns "Invalid Date" here; Intl's format() would throw
  // and take the whole list down with it.
  if (Number.isNaN(date.getTime())) return 'Invalid Date'
  return formatter(locale, options).format(date)
}
