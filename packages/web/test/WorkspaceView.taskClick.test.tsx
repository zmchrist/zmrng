import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { WorkspaceView } from '../src/components/WorkspaceView'
import { hydrateGrid, hideCard } from '../src/gridLayout'
import { hydrateLayout, openFile } from '../src/workspaceLayout'
import type { GridState, PerTaskUiState, Task } from '../src/types'

// WorkspaceView fetches files/agents on mount — keep the network out of a unit
// test, mirroring the WorkspaceTabs test's api mock.
vi.mock('../src/api', () => ({
  api: {
    getFiles: vi.fn().mockResolvedValue({ root: null, entries: [] }),
    getProjectFiles: vi.fn().mockResolvedValue({ root: null, entries: [] }),
    listAgents: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue({ path: 'x', format: 'code', encoding: 'utf8', content: '' }),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
    getChat: vi.fn().mockResolvedValue([]),
    sendChat: vi.fn().mockResolvedValue(''),
  },
}))

// jsdom has no ResizeObserver — the grid host observes its own width.
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

/** Stateful harness owning selection/grid/per-task state, mirroring what App.tsx wires. */
function Harness({ initialGrid, initialPerTask = {} }: { initialGrid: GridState; initialPerTask?: Record<string, PerTaskUiState> }) {
  const [selectedId, setSelectedId] = useState<string | null>('t1')
  const [grid, setGrid] = useState(initialGrid)
  const [perTask, setPerTask] = useState<Record<string, PerTaskUiState>>(initialPerTask)
  const selected = TASKS.find((t) => t.id === selectedId)

  return (
    <WorkspaceView
      task={selected}
      events={[]}
      live=""
      perTask={perTask}
      onPerTaskChange={(id, patch) =>
        setPerTask((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
      }
      tasks={TASKS}
      repos={[{ id: 'zmrng', label: 'zmrng', path: '/x', defaultBranch: 'main' }]}
      config={null}
      selectedId={selectedId}
      grid={grid}
      onGridChange={setGrid}
      chatTabs={{ tabs: [], activeId: null }}
      onChatTabsChange={() => {}}
      terminalTabs={{ tabs: [], activeId: null }}
      onTerminalTabsChange={() => {}}
      settingsOpen={false}
      onSettingsToggle={() => {}}
      connected
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

/** Click the TaskList row button for a given title, disambiguated from the
 *  same title appearing elsewhere (the WorkspaceTabs "other live task" tab
 *  button, the ConcurrencyCard lane title, etc.) — the TaskList row button
 *  is the one whose class name is CSS-modules-scoped from `TaskList.module.css`
 *  (`_row_...`), unlike the tab strip's `_tabLabel_...` button. */
function clickTaskListRow(title: string) {
  const matches = screen.getAllByText(title)
  const row = matches
    .map((el) => el.closest('button'))
    .find((btn): btn is HTMLButtonElement => !!btn && /(^|\s)_row_/.test(btn.className))
  if (!row) throw new Error(`no TaskList row button found for "${title}"`)
  fireEvent.click(row)
}

describe('TaskList click auto-focuses the Worker Log tab', () => {
  it('un-hides the Viewers card and shows the log tab for a task whose layout has a file focused', async () => {
    const t2Layout = openFile(hydrateLayout(), 'some/file.ts')
    const grid = hideCard(hydrateGrid(), 'viewers')
    render(<Harness initialGrid={grid} initialPerTask={{ t2: { layout: t2Layout } }} />)

    await screen.findAllByText('Task Two')
    clickTaskListRow('Task Two')

    const tablist = await screen.findByRole('tablist', { name: 'Open tabs' })
    const logTab = within(tablist).getByRole('tab', { name: /worker log|task two/i })
    expect(logTab).toHaveAttribute('aria-selected', 'true')
  })

  it('re-focuses the log tab when re-clicking the already-selected row', async () => {
    const t1Layout = openFile(hydrateLayout(), 'some/file.ts')
    render(<Harness initialGrid={hydrateGrid()} initialPerTask={{ t1: { layout: t1Layout } }} />)

    // Initially the persisted layout has the file tab focused, not the log tab.
    const tablist = await screen.findByRole('tablist', { name: 'Open tabs' })
    expect(within(tablist).getByRole('tab', { name: /file\.ts/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    clickTaskListRow('Task One')

    expect(within(tablist).getByRole('tab', { name: /worker log|task one/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })
})
