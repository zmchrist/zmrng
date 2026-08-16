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
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('steer this'))
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
})
