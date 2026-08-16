import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { usePanelMount } from '../src/usePanelMount'

/** Tiny probe component: renders "mounted"/"unmounted" from the hook's return
 *  value, and re-renders when `open` changes via props. */
function Probe({ open }: { open: boolean }) {
  const mounted = usePanelMount(open, 100)
  return <div>{mounted ? 'mounted' : 'unmounted'}</div>
}

afterEach(() => {
  vi.useRealTimers()
})

describe('usePanelMount', () => {
  it('is mounted immediately when open starts true', () => {
    render(<Probe open={true} />)
    expect(screen.getByText('mounted')).toBeInTheDocument()
  })

  it('is unmounted immediately when open starts false', () => {
    render(<Probe open={false} />)
    expect(screen.getByText('unmounted')).toBeInTheDocument()
  })

  it('stays mounted for `duration` ms after open flips false, then unmounts', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Probe open={true} />)
    expect(screen.getByText('mounted')).toBeInTheDocument()

    rerender(<Probe open={false} />)
    // Still mounted right after the flip — the closing animation gets its window.
    expect(screen.getByText('mounted')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(screen.getByText('mounted')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(60)
    })
    expect(screen.getByText('unmounted')).toBeInTheDocument()
  })

  it('re-mounts immediately if open flips back true before the unmount timer fires', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Probe open={true} />)
    rerender(<Probe open={false} />)

    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(screen.getByText('mounted')).toBeInTheDocument()

    rerender(<Probe open={true} />)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getByText('mounted')).toBeInTheDocument()
  })
})
