import { describe, it, expect } from 'vitest'
import { errorText, NO_CONNECTION } from './errorText'

describe('errorText', () => {
  it('says the connection is lost for network errors', () => {
    expect(errorText(new TypeError('Failed to fetch'), 'Could not load')).toBe(NO_CONNECTION)
    expect(errorText(new Error('Load failed'), 'x')).toBe(NO_CONNECTION)
  })
  it('falls back for technical errors', () => {
    expect(errorText(new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON'), 'Could not load splits')).toBe('Could not load splits')
    expect(errorText(new Error("Cannot read properties of undefined (reading 'id')"), 'Could not save')).toBe('Could not save')
    expect(errorText(null, 'Could not save')).toBe('Could not save')
  })
  it('keeps a real message', () => {
    expect(errorText(new Error('This split is already settled'), 'x')).toBe('This split is already settled')
  })
})
