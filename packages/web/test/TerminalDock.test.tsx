import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { TerminalDock } from '../src/components/TerminalDock'

// Terminal itself is explicitly not unit-tested (xterm needs a real canvas, absent
// in jsdom) — stub it with a component whose mount/unmount we can observe, so this
// test proves the PTY-owning component survives a minimize/restore toggle instead
// of being torn down and recreated.
const onMount = vi.fn()
const onUnmount = vi.fn()
vi.mock('../src/components/Terminal', () => ({
  Terminal: ({ id }: { id: string }) => {
    useState(() => {
      onMount(id)
      return null
    })
    return <div data-testid={`term-${id}`}>{id}</div>
  },
}))

/** Stateful harness mirroring how WorkspaceView/App own the dock's persisted chrome. */
function Harness() {
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(300)
  return (
    <TerminalDock
      open={open}
      height={height}
      onOpenChange={setOpen}
      onHeightChange={setHeight}
      tasksOpen={false}
      workspaceOpen={false}
      settingsOpen={false}
      onTasksToggle={() => {}}
      onWorkspaceToggle={() => {}}
      onSettingsToggle={() => {}}
    />
  )
}

describe('<TerminalDock>', () => {
  it('keeps the terminal mounted (PTY/WebSocket alive) across minimize + restore', () => {
    onMount.mockClear()
    onUnmount.mockClear()
    render(<Harness />)

    // Open the dock — auto-seeds the first terminal tab.
    fireEvent.click(screen.getByRole('button', { name: 'Show terminal' }))
    expect(onMount).toHaveBeenCalledTimes(1)
    const mountedId = onMount.mock.calls[0][0] as string
    expect(screen.getByTestId(`term-${mountedId}`)).toBeInTheDocument()

    // Minimize via the nav-bar Terminal button — the bug this fixes was
    // unmounting the terminal body here, killing the PTY WebSocket.
    fireEvent.click(screen.getByRole('button', { name: 'Hide terminal' }))
    // The terminal instance is still in the DOM (CSS-hidden), not unmounted.
    expect(screen.getByTestId(`term-${mountedId}`)).toBeInTheDocument()
    expect(onMount).toHaveBeenCalledTimes(1) // no remount

    // Restore — same instance, no re-seed of a second tab.
    fireEvent.click(screen.getByRole('button', { name: 'Show terminal' }))
    expect(onMount).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId(`term-${mountedId}`)).toBeInTheDocument()
  })
})
