// What a person sees when something fails. Raw errors ("TypeError: Failed to
// fetch", a JSON parse error, an HTTP status) mean nothing to them: a lost
// connection says so plainly, other technical errors fall back to the
// screen's own message, and a real message from the server is kept.

const NETWORK = /failed to fetch|networkerror|network error|load failed|network request failed|err_internet|err_network|err_connection|offline|timed? ?out|timeout|aborterror|the operation was aborted/i
const TECHNICAL = /typeerror|referenceerror|syntaxerror|unexpected token|is not valid json|json\.parse|undefined|null|cannot read|is not a function|\bhttp ?\d{3}\b|status code|^\d{3}\b|<!doctype|internal server error|fetch failed/i

export const NO_CONNECTION = 'No connection - check your internet and try again'

/** The text to show for error `e`, or `fallback` when its own message isn't meant for people. */
export function errorText(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if (!msg.trim()) return fallback
  if (NETWORK.test(msg) || (typeof navigator !== 'undefined' && navigator.onLine === false)) return NO_CONNECTION
  if (TECHNICAL.test(msg) || msg.length > 180) return fallback
  return msg
}
