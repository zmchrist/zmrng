// Curated set of common reaction emoji for the Team chat reaction picker.
//
// The agreed scope pins the picker to a small curated set of "main" emoji (~40),
// deliberately NOT the full Unicode catalogue and NOT skin-tone variants. It is a
// static constant (no runtime data fetch) so the picker works fully offline in
// the bundled desktop app, and it is rendered by our own frosted-glass grid so it
// stays on-theme with no third-party picker DOM to restyle.

/** The ordered list of reaction emoji shown in the picker grid. */
export const REACTION_EMOJI: readonly string[] = [
  '👍',
  '👎',
  '❤️',
  '🔥',
  '🎉',
  '🚀',
  '👀',
  '✅',
  '❌',
  '💯',
  '🙏',
  '👏',
  '🙌',
  '💪',
  '🤝',
  '👌',
  '✨',
  '⭐',
  '⚡',
  '💡',
  '😀',
  '😂',
  '🤣',
  '😅',
  '😊',
  '😍',
  '😎',
  '🤔',
  '😮',
  '😢',
  '😭',
  '😡',
  '🥳',
  '🤯',
  '🐛',
  '🎯',
  '🚨',
  '📌',
  '⏰',
  '👋',
]
