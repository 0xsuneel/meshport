// One outer width for every card in a chat conversation - payments, bills,
// payment requests and shared payment links - so they line up as a set.
// Bill / request / link cards sit inside the message bubble, which wraps a
// card-only message with CHAT_CARD_BUBBLE_PAD of padding (+ a 1px border on
// received bubbles); cardInnerWidth() gives the card the width that makes the
// bubble's outer edge match a payment card exactly.
export const CHAT_CARD_W = 208
export const CHAT_CARD_BUBBLE_PAD = 4
export const cardInnerWidth = (isMine: boolean) => CHAT_CARD_W - CHAT_CARD_BUBBLE_PAD * 2 - (isMine ? 0 : 2)
