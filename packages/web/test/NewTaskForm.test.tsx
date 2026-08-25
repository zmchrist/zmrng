import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NewTaskForm } from '../src/components/NewTaskForm'
import type { HandoffPrefill } from '../src/teamHandoff'
import type { RepoTarget } from '../src/types'

const repos: RepoTarget[] = [
  { id: 'zmrng', label: 'zmrng', path: '/p/zmrng', defaultBranch: 'main' },
  { id: 'pheme', label: 'pheme', path: '/p/pheme', defaultBranch: 'main' },
]

const noop = async () => {}

describe('<NewTaskForm> handoff prefill', () => {
  it('opens + seeds title/body from a prefill and signals it was consumed', () => {
    const onPrefillConsumed = vi.fn()
    const prefill: HandoffPrefill = { title: 'Fix the widget', body: 'do the thing\n\n---\nFrom team channel #general (message #7)' }
    render(
      <NewTaskForm
        repos={repos}
        defaultRepoId="zmrng"
        onCreate={noop}
        prefill={prefill}
        onPrefillConsumed={onPrefillConsumed}
      />,
    )
    // The form auto-opens and seeds its fields from the prefill.
    expect(screen.getByDisplayValue('Fix the widget')).toBeInTheDocument()
    expect(screen.getByDisplayValue(/do the thing/)).toBeInTheDocument()
    // The one-shot prefill is reported consumed so the parent clears it —
    // this is what stops a later remount from re-seeding an already-sent handoff.
    expect(onPrefillConsumed).toHaveBeenCalledTimes(1)
  })

  it('does not signal consumed when there is no prefill', () => {
    const onPrefillConsumed = vi.fn()
    render(
      <NewTaskForm
        repos={repos}
        defaultRepoId="zmrng"
        onCreate={noop}
        prefill={null}
        onPrefillConsumed={onPrefillConsumed}
      />,
    )
    // Closed by default; nothing seeded, nothing consumed.
    expect(screen.getByRole('button', { name: /new task/i })).toBeInTheDocument()
    expect(onPrefillConsumed).not.toHaveBeenCalled()
  })

  it('does not re-seed nor re-signal on a re-render with the same prefill object', () => {
    const onPrefillConsumed = vi.fn()
    const prefill: HandoffPrefill = { title: 'Once only', body: 'seed once' }
    const { rerender } = render(
      <NewTaskForm
        repos={repos}
        defaultRepoId="zmrng"
        onCreate={noop}
        prefill={prefill}
        onPrefillConsumed={onPrefillConsumed}
      />,
    )
    rerender(
      <NewTaskForm
        repos={repos}
        defaultRepoId="zmrng"
        onCreate={noop}
        prefill={prefill}
        onPrefillConsumed={onPrefillConsumed}
      />,
    )
    // Same identity → seeded exactly once; consumed reported exactly once.
    expect(onPrefillConsumed).toHaveBeenCalledTimes(1)
    expect(screen.getByDisplayValue('Once only')).toBeInTheDocument()
  })
})
