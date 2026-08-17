import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { WorkspaceTabs } from '../src/components/WorkspaceTabs'
import { emptyLayout, fileTabId, openFile, openPanel, splitWith } from '../src/workspaceLayout'
import type { AgentSummary, TaskStatus, WorkspaceLayout } from '../src/types'

// Keep the tab-content children (Viewer / Chat) hermetic — they fetch on
// mount, which we never want to hit the network in a unit test.
vi.mock('../src/api', () => ({
  api: {
    readFile: vi.fn().mockResolvedValue({ path: 'x', format: 'code', encoding: 'utf8', content: '' }),
    getChat: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue(''),
  },
}))

const AGENTS: AgentSummary[] = [{ id: 'a1', label: 'Agent One' }]

/** Stateful harness so reducer-driven interactions actually re-render. */
function Harness({
  initial,
  status = 'executing',
  agents = [],
  taskTitle = null,
  liveTasks = [],
  onSelectTask,
}: {
  initial: WorkspaceLayout
  status?: TaskStatus
  agents?: AgentSummary[]
  taskTitle?: string | null
  liveTasks?: { id: string; title: string }[]
  onSelectTask?: (id: string) => void
}) {
  const [layout, setLayout] = useState(initial)
  return (
    <WorkspaceTabs
      taskId="t1"
      taskTitle={taskTitle}
      status={status}
      events={[]}
      live=""
      agents={agents}
      layout={layout}
      onLayoutChange={setLayout}
      liveTasks={liveTasks}
      onSelectTask={onSelectTask}
    />
  )
}

describe('<WorkspaceTabs>', () => {
  it('renders a tab per open tab, with exactly one selected', async () => {
    const layout = openFile(emptyLayout(), 'a.ts') // [log, file:a], active file:a
    render(<Harness initial={layout} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Worker Log' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'a.ts' })).toBeInTheDocument()
    await act(async () => {}) // flush Viewer's async load inside act()
  })

  it('hides the Worker-Log close control while the task is active, shows it once terminal', () => {
    const { unmount } = render(<Harness initial={emptyLayout()} status="executing" />)
    expect(screen.queryByRole('button', { name: /close worker log/i })).toBeNull()
    expect(screen.getByRole('button', { name: /minimize worker log/i })).toBeInTheDocument()
    unmount()

    render(<Harness initial={emptyLayout()} status="review" />)
    expect(screen.getByRole('button', { name: /close worker log/i })).toBeInTheDocument()
  })

  it('minimizes the log pane to a strip and restores it on click', async () => {
    let layout = openFile(emptyLayout(), 'a.ts')
    layout = splitWith(layout, fileTabId('a.ts'), 'left') // pane0 [file:a], pane1 [log]
    render(<Harness initial={layout} status="executing" />)

    fireEvent.click(screen.getByRole('button', { name: /minimize worker log/i }))
    // Log tab strip is gone; a click-to-expand strip stands in its place.
    expect(screen.queryByRole('tab', { name: 'Worker Log' })).toBeNull()
    const strip = screen.getByRole('button', { name: /expand worker log/i })

    fireEvent.click(strip)
    expect(screen.getByRole('tab', { name: 'Worker Log' })).toBeInTheDocument()
    await act(async () => {}) // flush Viewer's async load inside act()
  })

  it('closes Chat and re-opens it from the button bar', async () => {
    const layout = openPanel(emptyLayout(), 'chat') // [log, chat], active chat
    render(<Harness initial={layout} status="review" agents={AGENTS} />)

    fireEvent.click(screen.getByRole('button', { name: /close chat/i }))
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull()

    // The button bar now offers a re-open control.
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument()
    // Flush Chat's async load so its state settles inside act().
    await act(async () => {})
  })

  it('closes a file tab via its X control', async () => {
    const layout = openFile(emptyLayout(), 'a.ts')
    render(<Harness initial={layout} status="executing" />)
    fireEvent.click(screen.getByRole('button', { name: /close a\.ts/i }))
    expect(screen.queryByRole('tab', { name: 'a.ts' })).toBeNull()
    await act(async () => {}) // flush Viewer's async load inside act()
  })

  it('exposes the ARIA tab roles and control labels', async () => {
    const layout = openPanel(emptyLayout(), 'chat')
    render(<Harness initial={layout} status="review" agents={AGENTS} />)
    const tablist = screen.getByRole('tablist')
    expect(tablist).toBeInTheDocument()
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs.length).toBeGreaterThanOrEqual(2)
    for (const tab of tabs) expect(tab).toHaveAttribute('aria-selected')
    expect(screen.getByRole('button', { name: /minimize worker log/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /close chat/i })).toBeInTheDocument()
    // Flush Chat's async load so its state settles inside act().
    await act(async () => {})
  })

  it('labels the Worker Log tab with the task title', () => {
    render(<Harness initial={emptyLayout()} taskTitle="Add reboot button" />)
    expect(screen.getByRole('tab', { name: 'Add reboot button' })).toBeInTheDocument()
  })

  it('truncates a long task title in the Worker Log tab', () => {
    const long = 'A very long task title that will not fit in a tab'
    render(<Harness initial={emptyLayout()} taskTitle={long} />)
    const tab = screen.getByRole('tab', { name: /…$/ })
    expect(tab.textContent).toHaveLength(24)
  })

  it('renders a tab per other live task, next to the Worker Log tab, and switches on click', async () => {
    const onSelectTask = vi.fn()
    render(
      <Harness
        initial={emptyLayout()}
        taskTitle="Task A"
        liveTasks={[{ id: 't2', title: 'Task B' }]}
        onSelectTask={onSelectTask}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Task A' })).toBeInTheDocument()
    const other = screen.getByRole('tab', { name: 'Task B' })
    expect(other).toBeInTheDocument()
    fireEvent.click(other)
    expect(onSelectTask).toHaveBeenCalledWith('t2')
    await act(async () => {})
  })

  it('only renders live-task tabs in the pane holding the Worker Log tab, not a sibling file pane', () => {
    let layout = openFile(emptyLayout(), 'a.ts')
    layout = splitWith(layout, fileTabId('a.ts'), 'left') // pane0 [file:a], pane1 [log]
    render(
      <Harness
        initial={layout}
        status="executing"
        taskTitle="Task A"
        liveTasks={[{ id: 't2', title: 'Task B' }]}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Task B' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab', { name: 'Task B' })).toHaveLength(1)
  })

  it('disambiguates same-titled live tasks with a short id suffix', () => {
    render(
      <Harness
        initial={emptyLayout()}
        taskTitle="Fix bug"
        liveTasks={[{ id: 'abcd1234', title: 'Fix bug' }]}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Fix bug #t1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Fix bug #abcd' })).toBeInTheDocument()
  })
})
