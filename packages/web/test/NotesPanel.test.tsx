import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { NotesPanel } from '../src/components/NotesPanel'
import type { Task } from '../src/types'

vi.mock('../src/api', () => ({
  api: {
    listNotes: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

function task(overrides: Partial<Task>): Task {
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
    model: null,
    effort: null,
    style: null,
    flow: 'direct',
    repoId: 'r1',
    usage: { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 },
    queued: false,
    blockedKind: null,
    blockedReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('<NotesPanel>', () => {
  it('only lists tasks that have a worktree in the dropdown', async () => {
    const tasks = [
      task({ id: 'no-wt', title: 'No Worktree', worktree: null }),
      task({ id: 'has-wt', title: 'Has Worktree', worktree: '/tmp/wt' }),
    ]
    render(
      <NotesPanel
        tasks={tasks}
        notesTaskId={null}
        onNotesTaskIdChange={vi.fn()}
        selectedPath={null}
        onOpen={vi.fn()}
      />,
    )
    const select = screen.getByRole('combobox', { name: /notes worktree/i })
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
    expect(options).toEqual(['Has Worktree'])
    await act(async () => {})
  })

  it('falls back to the first worktree task when notesTaskId does not resolve to one', async () => {
    const tasks = [task({ id: 'has-wt', title: 'Has Worktree', worktree: '/tmp/wt' })]
    render(
      <NotesPanel
        tasks={tasks}
        notesTaskId="stale-id"
        onNotesTaskIdChange={vi.fn()}
        selectedPath={null}
        onOpen={vi.fn()}
      />,
    )
    const select = screen.getByRole('combobox', { name: /notes worktree/i }) as HTMLSelectElement
    expect(select.value).toBe('has-wt')
    await act(async () => {})
  })

  it('calls onNotesTaskIdChange when the operator picks a different worktree', async () => {
    const tasks = [
      task({ id: 'a', title: 'Task A', worktree: '/tmp/a' }),
      task({ id: 'b', title: 'Task B', worktree: '/tmp/b' }),
    ]
    const onChange = vi.fn()
    render(
      <NotesPanel
        tasks={tasks}
        notesTaskId="a"
        onNotesTaskIdChange={onChange}
        selectedPath={null}
        onOpen={vi.fn()}
      />,
    )
    const select = screen.getByRole('combobox', { name: /notes worktree/i })
    fireEvent.change(select, { target: { value: 'b' } })
    expect(onChange).toHaveBeenCalledWith('b')
    await act(async () => {})
  })

  it('shows the no-worktrees state and disables the dropdown when nothing has a worktree', () => {
    render(
      <NotesPanel
        tasks={[task({ id: 'no-wt', worktree: null })]}
        notesTaskId={null}
        onNotesTaskIdChange={vi.fn()}
        selectedPath={null}
        onOpen={vi.fn()}
      />,
    )
    const select = screen.getByRole('combobox', { name: /notes worktree/i })
    expect(select).toBeDisabled()
    expect(screen.getByText(/no worktrees available/i)).toBeInTheDocument()
  })
})
