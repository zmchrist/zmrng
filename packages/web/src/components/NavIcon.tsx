import type { ReactNode } from 'react'

/**
 * The single source for every navigation icon — the desktop `ActivityRail` and
 * the phone shell's `MobileNav` both draw from here so the two can't drift.
 * Every icon is a single-stroke outline (24 viewBox, 1.6 stroke, round caps and
 * joins, no fill) in `currentColor`, so it follows the caller's text/accent
 * color. Drawn as inline SVG rather than Unicode glyphs because no glyph set
 * renders as a consistent outline across systems.
 */
export type NavIconName =
  | 'workspace'
  | 'team'
  | 'kb'
  | 'settings'
  | 'files'
  | 'terminal'
  | 'chat'
  | 'lanes'
  | 'smile'
  | 'close'
  | 'plus'
  | 'grip'
  | 'chevron-right'
  | 'chevron-down'
  | 'refresh'
  | 'arrow-down'
  | 'minus'
  | 'square'
  | 'tool'

const SHAPES: Record<NavIconName, ReactNode> = {
  // Simple outline speech bubble with a tail.
  team: <path d="M8.1 19.6A8.7 8.7 0 1 0 4.4 15.9L2.6 21.4Z" />,
  // 2×2 grid of rounded squares (the card grid).
  workspace: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </>
  ),
  // Open book.
  kb: (
    <>
      <path d="M12 6.5C10.5 5 8 4.5 3.5 4.5v13c4.5 0 7 .5 8.5 2 1.5-1.5 4-2 8.5-2v-13C16 4.5 13.5 5 12 6.5Z" />
      <path d="M12 6.5v13" />
    </>
  ),
  // Gear.
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>
  ),
  // Document with a folded corner.
  files: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </>
  ),
  // Terminal window with a prompt.
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="m7.5 10 3 2.5-3 2.5" />
      <path d="M13 15h3.5" />
    </>
  ),
  // Three stacked lanes of decreasing length (the execute-lane pool).
  lanes: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h11" />
      <path d="M4 17h6" />
    </>
  ),
  // Four-point sparkle.
  chat: <path d="M12 3c.8 4.6 2.4 6.2 7 7-4.6.8-6.2 2.4-7 7-.8-4.6-2.4-6.2-7-7 4.6-.8 6.2-2.4 7-7Z" />,
  // Smiley face (add reaction).
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.2a4.2 4.2 0 0 0 7 0" />
      <path d="M9 9.6h.01M15 9.6h.01" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  // Six-dot drag grip.
  grip: <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth="2.6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6" />,
  minus: <path d="M6 12h12" />,
  square: <rect x="6" y="6" width="12" height="12" rx="1.8" />,
  // Wrench (tool call).
  tool: <path d="M14.7 6.3a4 4 0 0 0 4.9 4.9L11 19.8a2.1 2.1 0 0 1-3-3Z" />,
}

interface Props {
  name: NavIconName
  /** Sizing is the caller's job (CSS Module) — the svg has no intrinsic size. */
  className?: string
}

export function NavIcon({ name, className }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {SHAPES[name]}
    </svg>
  )
}
