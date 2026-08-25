import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TaskList } from '../src/components/TaskList'
import type { RepoTarget, Task, TaskStatus } from '../src/types'

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Wire up the dashboard',
    body: '',
    status: 'executing' as TaskStatus,
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

const repos: RepoTarget[] = [{ id: 'zmrng', label: 'zmrng', path: '/x', defaultBranch: 'main' }]

describe('<TaskList>', () => {
  it('renders the empty state when there are no tasks', () => {
    render(<TaskList tasks={[]} repos={repos} selectedId={null} onSelect={() => {}} />)
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument()
  })

  it('renders a row per task with its status label', () => {
    const tasks = [
      makeTask({ id: 'a', title: 'First task', status: 'executing' }),
      makeTask({ id: 'b', title: 'Second task', status: 'review' }),
    ]
    render(<TaskList tasks={tasks} repos={repos} selectedId="a" onSelect={() => {}} />)
    expect(screen.getByText('First task')).toBeInTheDocument()
    expect(screen.getByText('Second task')).toBeInTheDocument()
    expect(screen.getByText('Executing')).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
  })

  it('shows "Queued" for a queued planning task', () => {
    render(
      <TaskList
        tasks={[makeTask({ status: 'planning', queued: true })]}
        repos={repos}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByText('Queued')).toBeInTheDocument()
  })

  it('fires onSelect with the task id when a row is clicked', () => {
    const onSelect = vi.fn()
    render(
      <TaskList
        tasks={[makeTask({ id: 'zzz', title: 'Clickable' })]}
        repos={repos}
        selectedId={null}
        onSelect={onSelect}
      />,
    )
    screen.getByText('Clickable').click()
    expect(onSelect).toHaveBeenCalledWith('zzz')
  })

  it('does not show action buttons for an unselected row', () => {
    render(
      <TaskList
        tasks={[makeTask({ id: 'a', status: 'backlog' })]}
        repos={repos}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  })

  it('expands the selected row to show its action buttons', () => {
    render(
      <TaskList
        tasks={[makeTask({ id: 'a', status: 'backlog' })]}
        repos={repos}
        selectedId="a"
        onSelect={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument()
  })

  it('fires the matching action callback from the expanded row', async () => {
    const onStart = vi.fn().mockResolvedValue(undefined)
    render(
      <TaskList
        tasks={[makeTask({ id: 'a', status: 'backlog' })]}
        repos={repos}
        selectedId="a"
        onSelect={() => {}}
        onStart={onStart}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(onStart).toHaveBeenCalled())
  })

  it('reveals the metadata dropdown on demand for the selected row', () => {
    render(
      <TaskList
        tasks={[makeTask({ id: 'a', status: 'executing', flow: 'plan' })]}
        repos={repos}
        selectedId="a"
        onSelect={() => {}}
      />,
    )
    expect(screen.queryByText('flow: plan')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    expect(screen.getByText('flow: plan')).toBeInTheDocument()
  })
})
