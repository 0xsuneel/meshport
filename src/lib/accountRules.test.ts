import { describe, it, expect } from 'vitest'
import { decideAccountAccess, foundAccountOf } from './accountRules'

describe('decideAccountAccess', () => {
  describe('log in', () => {
    it('lets a matching type in', () => {
      expect(decideAccountAccess('personal', 'personal', 'login')).toEqual({ kind: 'allow' })
      expect(decideAccountAccess('business', 'business', 'login')).toEqual({ kind: 'allow' })
    })
    it('refuses the other type and names the existing one', () => {
      expect(decideAccountAccess('personal', 'business', 'login')).toEqual({ kind: 'mismatch', existing: 'business' })
      expect(decideAccountAccess('business', 'personal', 'login')).toEqual({ kind: 'mismatch', existing: 'personal' })
    })
    it('never gives access without a MeshPort account', () => {
      expect(decideAccountAccess('personal', 'none', 'login')).toEqual({ kind: 'no_account' })
      expect(decideAccountAccess('business', 'none', 'login')).toEqual({ kind: 'no_account' })
      expect(decideAccountAccess(null, 'none', 'login')).toEqual({ kind: 'no_account' })
    })
    it('with no type chosen, uses the account’s own type', () => {
      expect(decideAccountAccess(null, 'business', 'login')).toEqual({ kind: 'allow' })
      expect(decideAccountAccess(null, 'personal', 'login')).toEqual({ kind: 'allow' })
    })
  })

  describe('create account', () => {
    it('creates only for a login / wallet with no account', () => {
      expect(decideAccountAccess('personal', 'none', 'create')).toEqual({ kind: 'allow' })
      expect(decideAccountAccess('business', 'none', 'create')).toEqual({ kind: 'allow' })
    })
    it('sends an existing account to log in, with its own type', () => {
      expect(decideAccountAccess('personal', 'personal', 'create')).toEqual({ kind: 'already_exists', existing: 'personal' })
      expect(decideAccountAccess('business', 'personal', 'create')).toEqual({ kind: 'already_exists', existing: 'personal' })
      expect(decideAccountAccess('personal', 'business', 'create')).toEqual({ kind: 'already_exists', existing: 'business' })
      expect(decideAccountAccess(null, 'business', 'create')).toEqual({ kind: 'already_exists', existing: 'business' })
    })
  })
})

describe('foundAccountOf', () => {
  it('needs a row with a username', () => {
    expect(foundAccountOf(null)).toBe('none')
    expect(foundAccountOf(undefined)).toBe('none')
    expect(foundAccountOf({ username: '', account_type: 'business' })).toBe('none')
    expect(foundAccountOf({ username: null })).toBe('none')
  })
  it('reads the type', () => {
    expect(foundAccountOf({ username: 'abhishek', account_type: 'business' })).toBe('business')
    expect(foundAccountOf({ username: 'sam', account_type: 'personal' })).toBe('personal')
    expect(foundAccountOf({ username: 'old' })).toBe('personal')
  })
})
