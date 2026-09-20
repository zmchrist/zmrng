import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MOBILE_QUERY, useIsMobile } from '../src/useIsMobile'

const listeners = new Set<() => void>()

/** Install a controllable `matchMedia` and return a setter for its match state. */
function stubMatchMedia(initial: boolean) {
  let matches = initial
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return matches
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }))
  return (next: boolean) => {
    matches = next
    act(() => {
      for (const fn of listeners) fn()
    })
  }
}

function Probe() {
  return <span>{useIsMobile() ? 'phone' : 'desktop'}</span>
}

afterEach(() => {
  listeners.clear()
  vi.unstubAllGlobals()
})

describe('useIsMobile', () => {
  it('targets a 768px phone breakpoint', () => {
    expect(MOBILE_QUERY).toBe('(max-width: 768px)')
  })

  it('reports the current match and re-renders when it changes', () => {
    const setMatches = stubMatchMedia(false)
    render(<Probe />)
    expect(screen.getByText('desktop')).toBeInTheDocument()

    setMatches(true)
    expect(screen.getByText('phone')).toBeInTheDocument()

    setMatches(false)
    expect(screen.getByText('desktop')).toBeInTheDocument()
  })

  it('falls back to desktop when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(<Probe />)
    expect(screen.getByText('desktop')).toBeInTheDocument()
  })
})
