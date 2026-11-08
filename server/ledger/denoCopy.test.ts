// The deployed ledger-interpret Edge Function runs a Deno copy of this
// directory (supabase/functions/ledger-interpret/). Deno needs `.ts` on
// relative imports, so it can't import these files directly. This test keeps
// the copy from drifting: a fix made (and tested) here must be copied there.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const FILES = ['classifiers.ts', 'interpreter.ts', 'repository.ts', 'types.ts']

/** Same code once import suffixes, dash styles and the copy's provenance header are set aside. */
function normalize(text: string): string {
  return text
    .replace(/ \* ── PROVENANCE[\s\S]*?── Original header below, unchanged ─*\n/, '')
    .replace(/^ \* supabase\/functions\/ledger-interpret\/[\w.]+\n \*\n/m, '')
    .replace(/from '(\.[^']*?)(\.ts)?'/g, "from '$1'")
    .replace(/[—–]/g, '-')
}

describe('ledger-interpret Deno copy', () => {
  for (const f of FILES) {
    it(`${f} matches server/ledger/${f}`, () => {
      const node = readFileSync(join(ROOT, 'server', 'ledger', f), 'utf8')
      const deno = readFileSync(join(ROOT, 'supabase', 'functions', 'ledger-interpret', f), 'utf8')
      expect(normalize(deno)).toBe(normalize(node))
    })
  }
})
