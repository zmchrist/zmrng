import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkerLogPanel } from '../src/components/WorkerLogPanel'
import type { TaskStatus } from '../src/types'

/** WorkerLog + ClarifyChat are both hermetic (no network), so no api mock. */
function renderPanel(status: TaskStatus, onMessage?: (t: string) => Promise<unknown>) {
  return render(<WorkerLogPanel events={[]} live="" status={status} onMessage={onMessage} />)
}

describe('<WorkerLogPanel>', () => {
  it('shows the steer composer in a live phase and sends the trimmed message', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined)
    renderPanel('executing', onMessage)
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: '  steer this  ' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('steer this', undefined))
  })

  it('shows the composer during clarify (the answer-questions phase)', () => {
    renderPanel('clarify', vi.fn())
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('hides the composer once the task leaves the live phases', () => {
    renderPanel('review', vi.fn())
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('hides the composer when no onMessage channel is provided', () => {
    renderPanel('executing')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('surfaces the error when a steer message is rejected (no silent drop)', async () => {
    const onMessage = vi.fn().mockRejectedValue(new Error('worker session has ended'))
    renderPanel('executing', onMessage)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'you there?' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() =>
      expect(screen.getByText(/worker session has ended/i)).toBeInTheDocument(),
    )
  })

  it('shows the session-ended notice and disables the composer for a stale task', () => {
    render(
      <WorkerLogPanel events={[]} live="" status="executing" onMessage={vi.fn()} stale />,
    )
    expect(screen.getByText(/session ended/i)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows a running-process strip above the composer, hidden when empty', () => {
    const { rerender } = renderPanel('executing', vi.fn())
    expect(screen.queryByRole('list', { name: /running processes/i })).toBeNull()
    rerender(
      <WorkerLogPanel
        events={[]}
        live=""
        status="executing"
        onMessage={vi.fn()}
        processes={[
          {
            id: 's1',
            kind: 'subagent',
            name: 'zmrng-qa',
            summary: 'run the suite',
            status: 'running',
            startedAt: Date.now(),
          },
        ]}
      />,
    )
    const strip = screen.getByRole('list', { name: /running processes/i })
    expect(strip).toHaveTextContent('zmrng-qa')
    expect(strip).toHaveTextContent('run the suite')
    expect(strip).toHaveTextContent('running')
    // pinned before the composer form
    expect(strip.compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
