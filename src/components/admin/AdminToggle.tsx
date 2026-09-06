interface AdminToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}

export function AdminToggle({ checked, onChange, disabled }: AdminToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 48,
        height: 28,
        borderRadius: 999,
        border: 'none',
        padding: 2,
        flexShrink: 0,
        background: checked ? 'var(--brand)' : 'color-mix(in srgb, var(--text-primary) 15%, transparent)',
        transition: 'background 0.18s ease',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: checked ? 'flex-end' : 'flex-start',
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
          transition: 'transform 0.18s ease',
          display: 'block',
        }}
      />
    </button>
  )
}
