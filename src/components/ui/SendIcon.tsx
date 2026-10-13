// The "send a message" arrow - solid and filled, used by every message send
// / "Message" control (chat composer, photo preview, New Chat, P2P trade
// chat). Deliberately not the outlined paper plane: that one is Pay (the chat
// header's Pay button), so sending a message and paying never look alike.
export function SendIcon({ size = 20, color = 'currentColor', className, style }: {
  size?: number; color?: string; className?: string; style?: React.CSSProperties
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className} style={style}>
      <path d="M3.4 20.4 21 12 3.4 3.6l-.01 6.5L15 12l-11.6 1.9z" fill={color} />
    </svg>
  )
}
