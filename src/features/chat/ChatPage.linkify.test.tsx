// src/features/chat/ChatPage.linkify.test.tsx
//
// Regression tests for linkifyText — chat message bubbles used to render
// raw text content directly with no URL detection at all: a pasted link
// was inert plain text (not underlined, not tappable), and worse, the whole
// message bubble has a long-press handler wired to onTouchStart with
// userSelect: 'none', so tapping what looked like a link either did
// nothing or triggered the bubble's Forward/Delete context menu instead —
// reported as a shared link "going outside the conversation" rather than
// opening it. Fixed by detecting URLs and wrapping each one in a real,
// tappable <a> with propagation stopped so it can't also trigger the
// bubble's long-press handling.
//
// This checks the returned React element STRUCTURE directly (plain
// createElement objects — no rendering needed), matching this repo's
// Node-only, no-jsdom test setup (see vitest.config.ts's own comment).

import { describe, it, expect, vi } from 'vitest'
import { isValidElement } from 'react'

// ChatPage.tsx imports @/lib/supabase directly, which constructs a real
// Supabase client at module load and throws without env vars — same issue
// hit by ActivityPage.test.ts and chatService.markRead.test.ts. linkifyText
// itself touches none of this; the mock just lets the module import succeed.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    channel: () => ({ on: () => ({ subscribe: () => {} }) }),
    removeChannel: () => {},
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
  },
  fetchConversations: async () => [],
  invalidateConversationsCache: () => {},
  getOrCreateConversation: async () => null,
  markMessagesRead: async () => {},
}))

import { linkifyText } from './ChatPage'

describe('linkifyText', () => {
  it('returns the original string unchanged when there is no URL', () => {
    const result = linkifyText('just a normal message', false)
    expect(result).toBe('just a normal message')
  })

  it('wraps a bare https:// URL in a real, tappable <a> element', () => {
    const result = linkifyText('check this out https://example.com/path', false)
    expect(Array.isArray(result)).toBe(true)
    const parts = result as any[]
    expect(parts[0]).toBe('check this out ')
    expect(isValidElement(parts[1])).toBe(true)
    expect((parts[1] as any).type).toBe('a')
    expect((parts[1] as any).props.href).toBe('https://example.com/path')
    expect((parts[1] as any).props.target).toBe('_blank')
    expect((parts[1] as any).props.rel).toBe('noopener noreferrer')
  })

  it('adds https:// to a bare www. link so it actually navigates instead of being treated as a relative path', () => {
    const result = linkifyText('go to www.example.com now', false)
    const parts = result as any[]
    const link = parts.find(p => isValidElement(p)) as any
    expect(link.props.href).toBe('https://www.example.com')
  })

  it('linkifies multiple URLs in the same message', () => {
    const result = linkifyText('a https://one.com and https://two.com b', false)
    const parts = result as any[]
    const links = parts.filter(p => isValidElement(p)) as any[]
    expect(links).toHaveLength(2)
    expect(links[0].props.href).toBe('https://one.com')
    expect(links[1].props.href).toBe('https://two.com')
  })

  it('stops click/touch propagation on the link so the bubble long-press handler cannot fire', () => {
    const result = linkifyText('https://example.com', false)
    const parts = result as any[]
    const link = parts.find(p => isValidElement(p)) as any
    expect(typeof link.props.onClick).toBe('function')
    expect(typeof link.props.onTouchStart).toBe('function')
    const stopped = { called: false }
    link.props.onClick({ stopPropagation: () => { stopped.called = true } })
    expect(stopped.called).toBe(true)
  })

  it('colors the link for readability against both bubble colors (mine vs theirs)', () => {
    const mine = (linkifyText('https://example.com', true) as any[]).find(isValidElement) as any
    const theirs = (linkifyText('https://example.com', false) as any[]).find(isValidElement) as any
    expect(mine.props.style.color).toBe('#fff')
    expect(theirs.props.style.color).toBe('var(--brand)')
  })

  it('preserves the exact URL text as the visible link label', () => {
    const url = 'https://eiy61xjbd.com?code=FLEOZH'
    const result = linkifyText(`click ${url} now`, false)
    const parts = result as any[]
    const link = parts.find(p => isValidElement(p)) as any
    expect(link.props.children).toBe(url)
  })
})
