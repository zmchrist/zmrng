import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { WorkspaceView } from '../src/components/WorkspaceView'
import type { LaneSnapshot, Task } from '../src/types'
import type { ChatTabState, TabsState, TerminalTabState } from '../src/windowTabs'
import type { MobileWorkspaceView } from '../src/mobileNav'

// Keep the network out of a unit test.
vi.mock('../src/api', () => ({
  api: {
    getFiles: vi.fn().mockResolvedValue({ root: null, entries: [] }),
    getProjectFiles: vi.fn().mockResolvedValue({ root: null, entries: [] }),
    readFile: vi.fn().mockResolvedValue({ path: 'x', format: 'code', encoding: 'utf8', content: '' }),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

// The real cards open WebSockets / xterm; stub them to expose only which tab
// is focused, which is all a Lanes click is allowed to change.
vi.mock('../src/components/ChatCard', () => ({
  ChatCard: ({ tabs }: { tabs: TabsState<ChatTabState> }) => (
    <div data-testid="chat-active">{tabs.activeId}</div>
  ),
}))
vi.mock('../src/components/TerminalCard', () => ({
  TerminalCard: ({ tabs }: { tabs: TabsState<TerminalTabState> }) => (
    <div data-testid="terminal-active">{tabs.activeId}</div>
  ),
}))

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error test stub
globalThis.ResizeObserver ??= StubResizeObserver

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Task One',
    body: '',
    status: 'executing',
    sessionId: null,
    branch: null,
    worktree: null,
    prUrl: null,
    blockedKind: null,
    planPath: null,
    model: 'opus',
    effort: 'high',
    style: 'normal',
    flow: 'plan',
    repoId: 'zmrng',
    usage: { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 },
    queued: false,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...over,
  }
}

const TASKS = [makeTask({ id: 't1', title: 'Task One' }), makeTask({ id: 't2', title: 'Task Two' })]

const LANES: LaneSnapshot = {
  at: '2026-09-23T12:00:00.000Z',
  execute: { cap: 4, holders: ['t2'], queued: [] },
  workers: [
    {
      taskId: 't2',
      model: 'opus',
      effort: 'high',
      style: 'normal',
      startedAt: '2026-09-23T11:59:00.000Z',
      holdsLane: true,
      subagents: [],
    },
  ],
  chats: [
    {
      id: 'lane-b',
      model: 'sonnet',
      effort: 'low',
      style: 'normal',
      repoId: null,
      voice: false,
      startedAt: '2026-09-23T11:55:00.000Z',
      usage: { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 },
    },
  ],
  terminals: [
    { id: 'pty-b', shell: '/bin/zsh', cwd: '/home/op', startedAt: '2026-09-23T11:50:00.000Z', attached: true },
  ],
}

const CHAT_DEFAULTS = {
  model: 'sonnet',
  effort: 'medium',
  style: 'normal',
  repoId: '',
  workflow: 'none',
  launched: true,
} as const

function Harness({ mobileView, onMobileViewChange }: {
  mobileView?: MobileWorkspaceView
  onMobileViewChange?: (v: MobileWorkspaceView) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>('t1')
  const [chatTabs, setChatTabs] = useState<TabsState<ChatTabState>>({
    tabs: [
      { id: 'chat-a', label: 'Chat 1', laneId: 'lane-a', ...CHAT_DEFAULTS },
      { id: 'chat-b', label: 'Chat 2', laneId: 'lane-b', ...CHAT_DEFAULTS },
    ],
    activeId: 'chat-a',
  })
  const [terminalTabs, setTerminalTabs] = useState<TabsState<TerminalTabState>>({
    tabs: [
      { id: 'term-a', label: 'Terminal 1', sessionId: 'pty-a' },
      { id: 'term-b', label: 'Terminal 2', sessionId: 'pty-b' },
    ],
    activeId: 'term-a',
  })
  return (
    <>
      <div data-testid="selected">{selectedId}</div>
      <WorkspaceView
        task={TASKS.find((t) => t.id === selectedId)}
        events={[]}
        securityScans={[]}
        live=""
        tasks={TASKS}
        lanes={LANES}
        repos={[{ id: 'zmrng', label: 'zmrng', path: '/x', defaultBranch: 'main' }]}
        config={null}
        selectedId={selectedId}
        tasksCollapsed={false}
        mobileView={mobileView}
        onMobileViewChange={onMobileViewChange}
        chatTabs={chatTabs}
        onChatTabsChange={setChatTabs}
        terminalTabs={terminalTabs}
        onTerminalTabsChange={setTerminalTabs}
        onSelect={setSelectedId}
        onCreate={async () => {}}
        onStart={async () => {}}
        onMessage={async () => {}}
        onResume={async () => {}}
        onRestart={async () => {}}
        onInterrupt={async () => {}}
        onDone={async () => {}}
        onCancel={async () => {}}
        onDelete={async () => {}}
      />
    </>
  )
}

function paneTab(name: RegExp) {
  return within(screen.getByRole('tablist', { name: 'Worker pane' })).getByRole('tab', { name })
}
const lanes = () => within(screen.getByRole('region', { name: 'Lanes' }))
const laneRow = (text: string) => lanes().getByText(text).closest('button')!

describe('Lanes row click jumps to its worker / chat / terminal', () => {
  it('a worker row selects its task and brings the Worker tab to the front', async () => {
    render(<Harness />)
    fireEvent.click(paneTab(/lanes/i))
    fireEvent.click(laneRow('Task Two'))
    expect(screen.getByTestId('selected')).toHaveTextContent('t2')
    expect(paneTab(/worker/i)).toHaveAttribute('aria-selected', 'true')
  })

  it('a chat row focuses the exact chat tab owning that session', () => {
    render(<Harness />)
    fireEvent.click(paneTab(/lanes/i))
    fireEvent.click(laneRow('chat'))
    expect(paneTab(/chat/i)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('chat-active')).toHaveTextContent('chat-b')
  })

  it('a terminal row focuses the exact terminal tab attached to that PTY', () => {
    render(<Harness />)
    fireEvent.click(paneTab(/lanes/i))
    fireEvent.click(laneRow('/bin/zsh'))
    expect(paneTab(/terminal/i)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('terminal-active')).toHaveTextContent('term-b')
  })

  it('on the phone shell, switches the full-screen view too', () => {
    const onMobileViewChange = vi.fn()
    render(<Harness mobileView="lanes" onMobileViewChange={onMobileViewChange} />)
    fireEvent.click(laneRow('Task Two'))
    fireEvent.click(laneRow('chat'))
    fireEvent.click(laneRow('/bin/zsh'))
    expect(onMobileViewChange.mock.calls).toEqual([['tasks'], ['chat'], ['terminal']])
  })

  it('leaves the phone view alone on desktop', () => {
    const onMobileViewChange = vi.fn()
    render(<Harness onMobileViewChange={onMobileViewChange} />)
    fireEvent.click(paneTab(/lanes/i))
    fireEvent.click(laneRow('chat'))
    expect(onMobileViewChange).not.toHaveBeenCalled()
  })
})
