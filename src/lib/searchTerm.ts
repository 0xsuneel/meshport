// What a search box's text means, the same in every list: case and spaces
// don't matter, and a username can be typed as "ravi" or "ravi.arc".
export function searchTerm(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.arc$/, '').trim()
}
