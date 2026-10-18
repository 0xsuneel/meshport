import { describe, it, expect } from 'vitest'
import { bareHandle, arcHandle, isFullUsername, matchPeople, mergeExact, recentFirst, pickerProblem, exactPick } from './userSearch'

const p = (id: string, username: string, display_name?: string) => ({ id, username, display_name: display_name ?? null })
const priya = p('1', 'priya', 'Priya Shah'), sunil = p('2', 'sunil', 'Sunil R'), sun = p('3', 'sunny', 'Sunny')

describe('handles', () => {
  it('cleans what was typed', () => {
    expect(bareHandle(' @Priya.ARC ')).toBe('priya')
    expect(arcHandle('priya')).toBe('priya.arc')
    expect(arcHandle('priya.arc')).toBe('priya.arc')
    expect(isFullUsername('sunil.arc')).toBe(true)
    expect(isFullUsername('sunil')).toBe(false)
    expect(isFullUsername('.arc')).toBe(false)
  })
})

describe('matchPeople', () => {
  it('matches name or username, partial and case-insensitive, keeping order', () => {
    expect(matchPeople([sunil, priya, sun], 'SUN')).toEqual([sunil, sun])
    expect(matchPeople([sunil, priya], 'shah')).toEqual([priya])
    expect(matchPeople([sunil], '  ')).toEqual([])
  })
})

describe('mergeExact', () => {
  it('puts the known exact username first and drops duplicates from the directory', () => {
    const dir = p('2', 'sunil', 'Sunil (dir)')
    expect(mergeExact([sunil, sun], [dir], 'sunil.arc')).toEqual([sunil])
    expect(mergeExact([sun], [dir], 'sunil.arc')).toEqual([dir])
  })
})

describe('recentFirst', () => {
  it('lists recent people first, once each, without me', () => {
    const me = p('9', 'me')
    expect(recentFirst([sunil, me], [priya, sunil, sun], '9').map(x => x.id)).toEqual(['2', '1', '3'])
  })
})

describe('pickerProblem / exactPick', () => {
  it('says what is wrong with a typed name', () => {
    expect(pickerProblem('', { searching: false, found: 0, self: false })).toBeNull()
    expect(pickerProblem('ghost.arc', { searching: true, found: 0, self: false })).toBeNull()
    expect(pickerProblem('ghost.arc', { searching: false, found: 1, self: false })).toBeNull()
    expect(pickerProblem('ghost.arc', { searching: false, found: 0, self: false })).toEqual({ text: 'No MeshPort user called ghost.arc', tone: 'danger' })
    expect(pickerProblem('me.arc', { searching: false, found: 0, self: true })?.text).toBe("That's your own username")
    expect(pickerProblem('gho', { searching: false, found: 0, self: false })?.tone).toBe('muted')
  })
  it('finds the person a full username names', () => {
    expect(exactPick('Sunil.arc', [sun, sunil])).toBe(sunil)
    expect(exactPick('sunil', [sunil])).toBeNull()
    expect(exactPick('ghost.arc', [sunil])).toBeNull()
  })
})
