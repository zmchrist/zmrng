import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { WorkspaceView } from '../src/components/WorkspaceView'
import type { MobileWorkspaceView } from '../src/mobileNav'
import type { Task } from '../src/types'

vi.mock('../src/api', () => ({
  api: {
    getFiles: vi.fn().mockResolvedValue({ root: null, entries: [] }),
    getProjectFiles: vi.fn().mockResolvedValue({ root: null, entries: [] }),
    readFile: vi
      .fn()
      .mockResolvedValue({ path: 'x', format: 'code', encoding: 'utf8', content: '' }),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error test stub
globalThis.ResizeObserver ??= StubResizeObserver

const TASK: Task = {
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
}

function renderView(mobileView?: MobileWorkspaceView) {
  return render(
    <WorkspaceView
      task={TASK}
      events={[]}
      securityScans={[]}
      live=""
      tasks={[TASK]}
      lanes={null}
      repos={[{ id: 'zmrng', label: 'zmrng', path: '/x', defaultBranch: 'main' }]}
      config={null}
      selectedId="t1"
      tasksCollapsed={false}
      mobileView={mobileView}
      chatTabs={{ tabs: [], activeId: null }}
      onChatTabsChange={() => {}}
      terminalTabs={{ tabs: [], activeId: null }}
      onTerminalTabsChange={() => {}}
      onSelect={() => {}}
      onCreate={async () => {}}
      onStart={async () => {}}
      onMessage={async () => {}}
      onResume={async () => {}}
      onRestart={async () => {}}
      onInterrupt={async () => {}}
      onDone={async () => {}}
      onCancel={async () => {}}
      onDelete={async () => {}}
    />,
  )
}

/** The tab panels are kept mounted and toggled with `display`, so "visible"
 *  means the panel's inline display is not `none`. */
function visiblePanels() {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter(
    (el) => el.style.display !== 'none',
  )
}

describe('<WorkspaceView> phone shell', () => {
  it('keeps the desktop tab strip when no mobileView is given', async () => {
    renderView()
    expect(screen.getByRole('tablist', { name: 'Worker pane' })).toBeInTheDocument()
    await screen.findAllByText('Task One')
  })

  it('drops the tab strip on a phone — the drawer picks the view instead', async () => {
    renderView('tasks')
    expect(screen.queryByRole('tablist', { name: 'Worker pane' })).not.toBeInTheDocument()
    await screen.findAllByText('Task One')
  })

  it('shows the task list stacked above the worker log for the Tasks view', async () => {
    renderView('tasks')
    await screen.findAllByText('Task One')
    const aside = document.querySelector('aside')!
    expect(aside).not.toHaveAttribute('aria-hidden')
    expect(visiblePanels()).toHaveLength(1)
  })

  it('hides the task list and shows only the picked view for the others', async () => {
    renderView('terminal')
    await screen.findAllByText('Task One')
    expect(document.querySelector('aside')).toHaveAttribute('aria-hidden', 'true')
    expect(visiblePanels()).toHaveLength(1)
  })

  it('shows the Lanes panel alone for the lanes view', async () => {
    renderView('lanes')
    await screen.findAllByText('Task One')
    const panels = visiblePanels()
    expect(panels).toHaveLength(1)
    expect(panels[0]).toContainElement(screen.getByLabelText('Lanes'))
  })
})

describe('<WorkspaceView> phone task-panel swipe handle', () => {
  beforeEach(() => localStorage.clear())

  function handle() {
    return screen.getByRole('button', { name: /task list/i })
  }
  function swipe(from: number, to: number) {
    const el = handle()
    fireEvent.touchStart(el, { touches: [{ clientY: from }] })
    fireEvent.touchEnd(el, { changedTouches: [{ clientY: to }] })
  }

  function pane() {
    return document.querySelector('section')!
  }

  it('offers the handle on the Tasks view only, starting at half screen', async () => {
    const { unmount } = renderView('tasks')
    await screen.findAllByText('Task One')
    expect(handle()).toHaveAttribute('data-position', 'split')
    unmount()

    renderView('terminal')
    expect(screen.queryByRole('button', { name: /task list/i })).not.toBeInTheDocument()
  })

  it('has no handle on desktop', async () => {
    renderView()
    await screen.findAllByText('Task One')
    expect(screen.queryByRole('button', { name: /task list/i })).not.toBeInTheDocument()
  })

  it('steps full list ↔ half ↔ full worker on swipes, stopping at the ends', async () => {
    renderView('tasks')
    await screen.findAllByText('Task One')

    swipe(300, 200)
    expect(handle()).toHaveAttribute('data-position', 'detail')
    expect(document.querySelector('aside')).toHaveAttribute('aria-hidden', 'true')
    expect(pane()).not.toHaveAttribute('aria-hidden')
    swipe(300, 200)
    expect(handle()).toHaveAttribute('data-position', 'detail')

    swipe(200, 300)
    expect(handle()).toHaveAttribute('data-position', 'split')
    expect(document.querySelector('aside')).not.toHaveAttribute('aria-hidden')

    swipe(200, 300)
    expect(handle()).toHaveAttribute('data-position', 'list')
    expect(pane()).toHaveAttribute('aria-hidden', 'true')
    swipe(200, 300)
    expect(handle()).toHaveAttribute('data-position', 'list')
  })

  it('cycles on a tap — the keyboard-accessible path — without double-applying', async () => {
    renderView('tasks')
    await screen.findAllByText('Task One')

    // A real tap fires touchend AND a synthetic click; only one must count.
    swipe(300, 300)
    fireEvent.click(handle())
    expect(handle()).toHaveAttribute('data-position', 'detail')

    // Pure clicks (keyboard activation) keep cycling back toward the list.
    fireEvent.click(handle())
    expect(handle()).toHaveAttribute('data-position', 'split')
    fireEvent.click(handle())
    expect(handle()).toHaveAttribute('data-position', 'list')
  })

  it('remembers the position across a remount', async () => {
    const { unmount } = renderView('tasks')
    await screen.findAllByText('Task One')
    swipe(300, 200)
    unmount()

    renderView('tasks')
    await screen.findAllByText('Task One')
    expect(handle()).toHaveAttribute('data-position', 'detail')
    expect(document.querySelector('aside')).toHaveAttribute('aria-hidden', 'true')
  })
})
