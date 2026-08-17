import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { TerminalDock } from '../src/components/TerminalDock'
import { loadChatOrder, loadChatThread, saveChatOrder, saveChatThread } from '../src/chatPersistence'

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
    settingsOpen: false,
    onTasksToggle: vi.fn(),
    onWorkspaceToggle: vi.fn(),
    onFilesToggle: vi.fn(),
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

// ChatPane owns a real WebSocket to /ws/chat — stub it the same way as
// Terminal so these tests stay hermetic and only exercise the dock's own
// hydrate/persist wiring around chat tabs.
const onChatMount = vi.fn()
vi.mock('../src/components/ChatPane', () => ({
  ChatPane: ({ id }: { id: string }) => {
    useState(() => {
      onChatMount(id)
      return null
    })
    return <div data-testid={`chat-${id}`}>{id}</div>
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
      settingsOpen={false}
      onTasksToggle={() => {}}
      onWorkspaceToggle={() => {}}
      onFilesToggle={() => {}}
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

describe('<TerminalDock> chat persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    onMount.mockClear()
    onChatMount.mockClear()
  })

  it('auto-reopens a persisted chat tab (and the dock body) on load', () => {
    saveChatOrder(['chat-9'], 'chat-9')
    saveChatThread('chat-9', [{ kind: 'user', text: 'hi' }])
    render(<Harness />)
    expect(onChatMount).toHaveBeenCalledWith('chat-9')
    expect(screen.getByTestId('chat-chat-9')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide terminal' })).toBeInTheDocument()
  })

  it('does not restore terminal tabs — only chat', () => {
    saveChatOrder(['chat-9'], 'chat-9')
    render(<Harness />)
    expect(onMount).not.toHaveBeenCalled()
    expect(onChatMount).toHaveBeenCalledWith('chat-9')
  })

  it('closing a chat tab clears its persisted transcript and order entry', () => {
    saveChatOrder(['chat-9'], 'chat-9')
    saveChatThread('chat-9', [{ kind: 'user', text: 'hi' }])
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /close chat 1/i }))
    expect(loadChatThread('chat-9')).toEqual([])
    expect(loadChatOrder().order).toEqual([])
  })

  it('persists a newly spawned chat tab so it round-trips through loadChatOrder', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    const { order } = loadChatOrder()
    expect(order).toHaveLength(1)
    expect(screen.getByTestId(`chat-${order[0]}`)).toBeInTheDocument()
  })
})
