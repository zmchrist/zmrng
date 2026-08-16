import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { WorkspaceTabs } from '../src/components/WorkspaceTabs'
import { emptyLayout, fileTabId, openFile, openPanel, splitWith } from '../src/workspaceLayout'
import type { TaskStatus, WorkspaceLayout } from '../src/types'

// Keep the tab-content children (Viewer / Notes / Chat) hermetic — they fetch on
// mount, which we never want to hit the network in a unit test.
vi.mock('../src/api', () => ({
  api: {
    readFile: vi.fn().mockResolvedValue({ path: 'x', format: 'code', encoding: 'utf8', content: '' }),
    listNotes: vi.fn().mockResolvedValue([]),
    getChat: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue(''),
  },
}))

/** Stateful harness so reducer-driven interactions actually re-render. */
function Harness({ initial, status = 'executing' }: { initial: WorkspaceLayout; status?: TaskStatus }) {
  const [layout, setLayout] = useState(initial)
  return (
    <WorkspaceTabs
      taskId="t1"
      status={status}
      events={[]}
      live=""
      agents={[]}
      layout={layout}
      onLayoutChange={setLayout}
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

  it('closes Notes and re-opens it from the button bar', async () => {
    const layout = openPanel(emptyLayout(), 'notes') // [log, notes], active notes
    render(<Harness initial={layout} status="review" />)

    fireEvent.click(screen.getByRole('button', { name: /close notes/i }))
    expect(screen.queryByRole('tab', { name: 'Notes' })).toBeNull()

    // The button bar now offers a re-open control.
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }))
    expect(screen.getByRole('tab', { name: 'Notes' })).toBeInTheDocument()
    // Flush Notes' async load so its state settles inside act().
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
    const layout = openPanel(emptyLayout(), 'notes')
    render(<Harness initial={layout} status="review" />)
    const tablist = screen.getByRole('tablist')
    expect(tablist).toBeInTheDocument()
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs.length).toBeGreaterThanOrEqual(2)
    for (const tab of tabs) expect(tab).toHaveAttribute('aria-selected')
    expect(screen.getByRole('button', { name: /minimize worker log/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /close notes/i })).toBeInTheDocument()
    // Flush Notes' async load so its state settles inside act().
    await act(async () => {})
  })
})
