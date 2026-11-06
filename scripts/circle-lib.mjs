// Shared helpers for the Circle scripts: hidden prompts, Circle's REST API,
// and the per-request Entity Secret ciphertext. No packages needed.

import crypto from 'node:crypto'

export const API = 'https://api.circle.com/v1/w3s'

// Hidden prompt (nothing echoed, nothing saved in shell history). Text typed
// or pasted past the first line is kept for the next prompt.
let pending = ''
// Windows Terminal wraps a paste in hidden codes (ESC[200~ ... ESC[201~);
// drop them, any other control characters, spaces and surrounding quotes.
export const clean = (v) => String(v)
  .replace(/\u001b\[20[01]~/g, '')
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .trim()
  .replace(/^['"]+|['"]+$/g, '')
  .trim()
export function ask(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(question)
    // The first non-empty line. Empty lines are skipped: on Windows the Enter
    // after one answer can leave a stray newline for the next prompt.
    const takeLine = () => {
      for (;;) {
        const nl = pending.search(/[\r\n]/)
        if (nl < 0) return null
        const line = clean(pending.slice(0, nl))
        pending = pending.slice(nl + 1)
        if (line) return line
      }
    }
    const finish = (line) => {
      stdin.off('data', onData); stdin.setRawMode?.(false); stdin.pause()
      process.stdout.write('\n'); resolve(line)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1) } // Ctrl+C
        if (ch === '\u0008' || ch === '\u007f') pending = pending.slice(0, -1)
        else pending += ch
      }
      const line = takeLine()
      if (line) finish(line)
    }
    const ready = takeLine()
    if (ready) return finish(ready)
    stdin.setRawMode?.(true)
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.resume()
  })
}

/** The API key and the Entity Secret, from the environment or hidden prompts. */
export async function credentials() {
  const apiKey = clean(process.env.CIRCLE_API_KEY || '') || await ask('Circle API key (hidden): ')
  const entitySecret = clean(process.env.CIRCLE_ENTITY_SECRET || '') || await ask('Entity Secret (hidden): ')
  if (!apiKey) throw new Error('Set CIRCLE_API_KEY')
  if (!/^[0-9a-fA-F]{64}$/.test(entitySecret)) {
    // Say what is wrong without showing the secret.
    const bad = [...new Set(entitySecret.replace(/[0-9a-fA-F]/g, ''))].length
    throw new Error(`The Entity Secret must be 64 hex characters (0-9, a-f). Got ${entitySecret.length} characters` +
      (bad ? `, with ${bad} kind(s) of non-hex character` : '') +
      '. Use the Entity Secret itself - not the ciphertext and not the recovery file.')
  }
  return { apiKey, entitySecret }
}

/** A Circle API client: call(method, path, body) and a fresh ciphertext() per request. */
export function circle({ apiKey, entitySecret }) {
  async function call(method, path, body) {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.message || JSON.stringify(j)}`)
    return j.data
  }

  // A fresh ciphertext for every request (Circle refuses a reused one).
  let publicKey
  async function ciphertext() {
    publicKey ??= (await call('GET', '/config/entity/publicKey')).publicKey
    return crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(entitySecret, 'hex'),
    ).toString('base64')
  }
  return { call, ciphertext }
}
