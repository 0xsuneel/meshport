import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// MeshPort's combined Google sign-in (src/wallet/circle.ts startGoogleSignIn)
// relies on Circle's Web SDK internals, not a documented API: it writes the
// SDK's own localStorage keys and imports its types from dist/src. This pins
// that contract, so an SDK upgrade that changes it fails here - not in
// production, as a sign-in that silently never reaches Circle.

const root = resolve(__dirname, '../..')
const sdkDir = resolve(root, 'node_modules/@circle-fin/w3s-pw-web-sdk')

describe("Circle Web SDK internals the sign-in depends on", () => {
  it('the SDK is pinned to the version these internals were checked against', () => {
    const app = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(app.dependencies['@circle-fin/w3s-pw-web-sdk']).toBe('1.1.11') // exact, no ^ or ~
    expect(JSON.parse(readFileSync(resolve(sdkDir, 'package.json'), 'utf8')).version).toBe('1.1.11')
  })

  it("the SDK reads the Google answer from the localStorage keys MeshPort writes", () => {
    const src = readFileSync(resolve(sdkDir, 'dist/src/index.js'), 'utf8')
    for (const key of ['state', 'nonce', 'socialLoginProvider']) expect(src).toContain(`localStorage.getItem('${key}')`)
  })

  it('the provider is spelled "Google" (anything else and the SDK never checks the sign-in with Circle)', async () => {
    const { SocialLoginProvider } = await import('@circle-fin/w3s-pw-web-sdk/dist/src/types')
    expect(SocialLoginProvider.GOOGLE).toBe('Google')
  })
})
