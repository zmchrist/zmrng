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
  // Four-point sparkle.
  chat: <path d="M12 3c.8 4.6 2.4 6.2 7 7-4.6.8-6.2 2.4-7 7-.8-4.6-2.4-6.2-7-7 4.6-.8 6.2-2.4 7-7Z" />,
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
