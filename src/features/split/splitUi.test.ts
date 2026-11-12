import { describe, it, expect } from 'vitest'
import { categoryForTitle, categoryForEmoji, SPLIT_CATEGORIES } from './splitUi'

describe('split categories', () => {
  it('picks the category from the expense name', () => {
    expect(categoryForTitle('Dinner at Toit').label).toBe('Dining out')
    expect(categoryForTitle('Uber to airport').label).toBe('Taxi')
    expect(categoryForTitle('November rent').label).toBe('Rent')
    expect(categoryForTitle('Electricity bill').label).toBe('Utilities')
    expect(categoryForTitle('Blinkit groceries').label).toBe('Groceries')
    expect(categoryForTitle('Goa trip').label).toBe('Travel')
    expect(categoryForTitle('Movie night').label).toBe('Movies')
    expect(categoryForTitle('Rohit birthday gift').label).toBe('Gifts')
  })
  it('anything else is Other', () => {
    expect(categoryForTitle('').label).toBe('Other')
    expect(categoryForTitle('misc stuff').label).toBe('Other')
  })
  it('every category has a distinct icon', () => {
    expect(new Set(SPLIT_CATEGORIES.map(c => c.emoji)).size).toBe(SPLIT_CATEGORIES.length)
    expect(categoryForEmoji('🚕').label).toBe('Taxi')
    expect(categoryForEmoji('❓').label).toBe('Other')
  })
})
