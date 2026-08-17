import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { TerminalDock } from '../src/components/TerminalDock'

/** Dock rendered closed (no terminal mounted, so no `/ws/terminal` socket is
 *  opened) — enough to exercise the nav bar's pane toggles, including the
 *  new Files button. */
function renderDock(overrides: Partial<React.ComponentProps<typeof TerminalDock>> = {}) {
  const props: React.ComponentProps<typeof TerminalDock> = {
    open: false,
    height: 300,
    onOpenChange: vi.fn(),
    onHeightChange: vi.fn(),
    tasksOpen: false,
    workspaceOpen: false,
    filesOpen: true,
    notesOpen: false,
    settingsOpen: false,
    onTasksToggle: vi.fn(),
    onWorkspaceToggle: vi.fn(),
    onFilesToggle: vi.fn(),
    onNotesToggle: vi.fn(),
    onSettingsToggle: vi.fn(),
    ...overrides,
  }
  return { ...render(<TerminalDock {...props} />), props }
}

describe('<TerminalDock> nav bar', () => {
  it('renders a Files toggle positioned after Workspace and before Settings', () => {
    renderDock()
    const buttons = screen.getAllByRole('button')
    const labels = buttons.map((b) => b.textContent)
    const workspaceIdx = labels.findIndex((l) => l?.includes('Workspace'))
    const filesIdx = labels.findIndex((l) => l?.includes('Files'))
    const settingsIdx = labels.findIndex((l) => l?.includes('Settings'))
    expect(workspaceIdx).toBeGreaterThanOrEqual(0)
    expect(filesIdx).toBeGreaterThan(workspaceIdx)
    expect(settingsIdx).toBeGreaterThan(filesIdx)
  })

  it('reflects filesOpen in aria-pressed and calls onFilesToggle when clicked', () => {
    const { props } = renderDock({ filesOpen: true })
    const filesBtn = screen.getByRole('button', { name: /hide files/i })
    expect(filesBtn).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(filesBtn)
    expect(props.onFilesToggle).toHaveBeenCalledTimes(1)
  })

  it('shows "Show files" when filesOpen is false', () => {
    renderDock({ filesOpen: false })
    expect(screen.getByRole('button', { name: /show files/i })).toBeInTheDocument()
  })

  it('renders a Notes toggle positioned after Files and before Settings', () => {
    renderDock()
    const buttons = screen.getAllByRole('button')
    const labels = buttons.map((b) => b.textContent)
    const filesIdx = labels.findIndex((l) => l?.includes('Files'))
    const notesIdx = labels.findIndex((l) => l?.includes('Notes'))
    const settingsIdx = labels.findIndex((l) => l?.includes('Settings'))
    expect(notesIdx).toBeGreaterThan(filesIdx)
    expect(settingsIdx).toBeGreaterThan(notesIdx)
  })

  it('reflects notesOpen in aria-pressed and calls onNotesToggle when clicked', () => {
    const { props } = renderDock({ notesOpen: true })
    const notesBtn = screen.getByRole('button', { name: /hide notes/i })
    expect(notesBtn).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(notesBtn)
    expect(props.onNotesToggle).toHaveBeenCalledTimes(1)
  })
})

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
      filesOpen={true}
      notesOpen={false}
      settingsOpen={false}
      onTasksToggle={() => {}}
      onWorkspaceToggle={() => {}}
      onFilesToggle={() => {}}
      onNotesToggle={() => {}}
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
