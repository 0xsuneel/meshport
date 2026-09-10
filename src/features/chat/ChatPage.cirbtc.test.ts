// src/features/chat/ChatPage.cirbtc.test.ts
//
// Regression tests for enabling cirBTC in ChatPay, matching the request
// "enable cirbtc for pay send and chatpay, work like others usdc and eurc,
// also need to show correctly in chat conversation page, cirbtc label".
//
// See ChatPage.linkify.test.tsx's own comment on this repo's Node-only,
// no-jsdom test setup and why @/lib/supabase needs mocking for this module
// to import at all.

import { describe, it, expect, vi } from 'vitest'

// ChatPage.tsx imports @/lib/supabase directly, which constructs a real
// Supabase client at module load and throws without env vars -- same issue
// ChatPage.linkify.test.tsx already works around. None of the functions
// under test here touch Supabase; the mock just lets the module import
// succeed.
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

import { formatPaymentMessagePreview, chatPayTokenDecimals, chatPayTokenSymbolChar, chatPayTokenIconBg } from './ChatPage'

describe('chatPayTokenDecimals', () => {
  // BUG FIX (this pass): a real ChatPay amount as small as 0.000004 USDC
  // couldn't even be typed or displayed correctly at 3 decimals -- it
  // rounded to "0.000" and, once trailing zeros are trimmed, showed as a
  // bare "0" on the payment card and in history. Every token now gets full
  // 8-decimal precision; formatAmount's trailing-zero trim keeps normal
  // amounts (e.g. "5 USDC") looking exactly as clean as before.
  it('gives every token 8 decimals -- USDC/EURC dust amounts need it just as much as cirBTC does', () => {
    expect(chatPayTokenDecimals('cirBTC')).toBe(8)
    expect(chatPayTokenDecimals('USDC')).toBe(8)
    expect(chatPayTokenDecimals('EURC')).toBe(8)
  })
})

describe('chatPayTokenSymbolChar / chatPayTokenIconBg', () => {
  it('gives each token its own symbol and icon color, cirBTC included', () => {
    expect(chatPayTokenSymbolChar('USDC')).toBe('$')
    expect(chatPayTokenSymbolChar('EURC')).toBe('€')
    expect(chatPayTokenSymbolChar('cirBTC')).toBe('₿')
    expect(chatPayTokenIconBg('cirBTC')).toBe('#F7931A')
  })
})

describe('formatPaymentMessagePreview', () => {
  const base = { isSelfChat: false, uname: 'alice', myId: 'user_me', lastMessageSender: null as string | null, myUsername: 'bob' }

  it('leaves non-payment messages untouched', () => {
    expect(formatPaymentMessagePreview('hey what time works?', base)).toBe('hey what time works?')
  })

  // BUG FIX regression: the guard used to hardcode `.includes(' USDC ')`,
  // so EURC/cirBTC payment messages fell through unrewritten for the
  // recipient -- they'd see "Sent 5 cirBTC to bob.arc" verbatim instead of
  // "Received 5 cirBTC from alice.arc".
  it('rewrites a cirBTC payment message to the recipient perspective (last_message_sender path)', () => {
    const result = formatPaymentMessagePreview('Sent 0.00025 cirBTC to bob.arc', {
      ...base, lastMessageSender: 'user_alice', myId: 'user_bob',
    })
    expect(result).toBe('Received 0.00025 cirBTC from alice.arc')
  })

  it('rewrites a cirBTC payment message to the recipient perspective (legacy null-sender path)', () => {
    const result = formatPaymentMessagePreview('Sent 0.00025 cirBTC to bob.arc', {
      ...base, lastMessageSender: null, myUsername: 'bob',
    })
    expect(result).toBe('Received 0.00025 cirBTC from alice.arc')
  })

  it('still handles EURC the same way -- this guard was never cirBTC-specific, EURC had the identical bug', () => {
    const result = formatPaymentMessagePreview('Sent 10.00 EURC to bob.arc', {
      ...base, lastMessageSender: 'user_alice', myId: 'user_bob',
    })
    expect(result).toBe('Received 10.00 EURC from alice.arc')
  })

  it('still handles USDC unchanged (no regression on the original behavior)', () => {
    const result = formatPaymentMessagePreview('Sent 5.00 USDC to bob.arc', {
      ...base, lastMessageSender: 'user_alice', myId: 'user_bob',
    })
    expect(result).toBe('Received 5.00 USDC from alice.arc')
  })

  it('keeps the message unchanged for the sender\'s own view', () => {
    const result = formatPaymentMessagePreview('Sent 0.001 cirBTC to bob.arc', {
      ...base, lastMessageSender: 'user_me', myId: 'user_me',
    })
    expect(result).toBe('Sent 0.001 cirBTC to bob.arc')
  })

  it('rewrites "to You" for a self-chat cirBTC payment', () => {
    const result = formatPaymentMessagePreview('Sent 0.001 cirBTC to sunil.arc', {
      ...base, isSelfChat: true,
    })
    expect(result).toBe('Sent 0.001 cirBTC to You')
  })
})
