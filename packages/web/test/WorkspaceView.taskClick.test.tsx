import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { WorkspaceView } from '../src/components/WorkspaceView'
import type { Task } from '../src/types'

// WorkspaceView fetches the file tree on mount — keep the network out of a unit
// test with a minimal api mock.
vi.mock('../src/api', () => ({
  api: {
    getFiles: vi.fn().mockResolvedValue({ root: null, entries: [] }),
    getProjectFiles: vi.fn().mockResolvedValue({ root: null, entries: [] }),
    readFile: vi.fn().mockResolvedValue({ path: 'x', format: 'code', encoding: 'utf8', content: '' }),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

// jsdom has no ResizeObserver — some panes observe their own width.
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
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...over,
  }
}

const TASKS = [makeTask({ id: 't1', title: 'Task One' }), makeTask({ id: 't2', title: 'Task Two' })]

/** Stateful harness owning selection, mirroring what App.tsx wires into the
 *  Cosmos IDE WorkspaceView (no grid/per-task layout — that subsystem was
 *  retired by the restructure). */
function Harness() {
  const [selectedId, setSelectedId] = useState<string | null>('t1')
  const selected = TASKS.find((t) => t.id === selectedId)

  return (
    <WorkspaceView
      task={selected}
      events={[]}
      live=""
      tasks={TASKS}
      repos={[{ id: 'zmrng', label: 'zmrng', path: '/x', defaultBranch: 'main' }]}
      config={null}
      selectedId={selectedId}
      chatTabs={{ tabs: [], activeId: null }}
      onChatTabsChange={() => {}}
      terminalTabs={{ tabs: [], activeId: null }}
      onTerminalTabsChange={() => {}}
      onSelect={(id) => setSelectedId(id)}
      onCreate={async () => {}}
      onStart={async () => {}}
      onMessage={async () => {}}
      onResume={async () => {}}
      onInterrupt={async () => {}}
      onDone={async () => {}}
      onCancel={async () => {}}
      onDelete={async () => {}}
    />
  )
}

/** Click the TaskList row button for a given title, disambiguated from the same
 *  title appearing elsewhere by matching the CSS-modules-scoped `_row_` class. */
function clickTaskListRow(title: string) {
  const matches = screen.getAllByText(title)
  const row = matches
    .map((el) => el.closest('button'))
    .find((btn): btn is HTMLButtonElement => !!btn && /(^|\s)_row_/.test(btn.className))
  if (!row) throw new Error(`no TaskList row button found for "${title}"`)
  fireEvent.click(row)
}

/** The worker-pane tab strip (Worker · Files · Terminal · Chat). */
function paneTab(name: RegExp) {
  const tablist = screen.getByRole('tablist', { name: 'Worker pane' })
  return within(tablist).getByRole('tab', { name })
}

describe('TaskList click auto-focuses the Worker pane tab (#95)', () => {
  it('brings the Worker tab to the front when a different task row is clicked', async () => {
    render(<Harness />)
    await screen.findAllByText('Task Two')

    // Move off the Worker tab first so the switch is observable.
    fireEvent.click(paneTab(/files/i))
    expect(paneTab(/files/i)).toHaveAttribute('aria-selected', 'true')
    expect(paneTab(/worker/i)).toHaveAttribute('aria-selected', 'false')

    clickTaskListRow('Task Two')

    expect(paneTab(/worker/i)).toHaveAttribute('aria-selected', 'true')
    expect(paneTab(/files/i)).toHaveAttribute('aria-selected', 'false')
  })

  it('re-focuses the Worker tab when re-clicking the already-selected row', async () => {
    render(<Harness />)
    await screen.findAllByText('Task One')

    fireEvent.click(paneTab(/terminal/i))
    expect(paneTab(/terminal/i)).toHaveAttribute('aria-selected', 'true')

    clickTaskListRow('Task One')

    expect(paneTab(/worker/i)).toHaveAttribute('aria-selected', 'true')
    expect(paneTab(/terminal/i)).toHaveAttribute('aria-selected', 'false')
  })
})
