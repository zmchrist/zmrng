// Registry letting the Terminal card's tab `×` reach the mounted <Terminal> for
// that tab and kill its PTY. Unmounting alone only detaches (grace window), so
// an explicit close needs a separate signal.

const closers = new Map<string, () => void>()

/** Register a mounted terminal's close handler; returns the unregister fn. */
export function registerTerminalCloser(id: string, close: () => void): () => void {
  closers.set(id, close)
  return () => {
    if (closers.get(id) === close) closers.delete(id)
  }
}

/** Kill the shell behind terminal tab `id` now (no-op if it isn't mounted). */
export function closeTerminal(id: string): void {
  closers.get(id)?.()
}
