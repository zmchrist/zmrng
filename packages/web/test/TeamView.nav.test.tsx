import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TeamView } from '../src/components/TeamView'

vi.mock('../src/api', () => ({
  api: {
    listChannels: vi.fn().mockResolvedValue([
      { id: 1, name: 'general', repoId: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, name: 'zmrng', repoId: null, createdAt: '2026-01-01T00:00:00.000Z' },
    ]),
    getChannelMessages: vi.fn().mockResolvedValue([]),
  },
}))

/** Minimal WebSocket stand-in: opens immediately, swallows every frame. */
class StubSocket {
  static OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    queueMicrotask(() => this.onopen?.())
  }
  send() {}
  close() {
    this.onclose?.()
  }
}

/** Force `useIsMobile()` to a fixed answer for the whole render. */
function setViewport(mobile: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: () => ({
      matches: mobile,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
}

function renderTeam() {
  return render(
    <TeamView
      teamHandle="Ada"
      onHandleChange={() => {}}
      botHandle="@agent"
      repos={[]}
      onSendToZmrng={() => {}}
      active
    />,
  )
}

describe('TeamView navigation', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('WebSocket', StubSocket)
    setViewport(false)
  })

  it('shows channels and roster as tabs, one list at a time', async () => {
    renderTeam()
    await screen.findByRole('button', { name: '#general' })

    // Channels tab is the default: the roster list is not rendered at all.
    expect(screen.getByRole('tab', { name: /channels/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.queryByText('No members yet.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /roster/i }))
    expect(screen.getByText('No members yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '#general' })).not.toBeInTheDocument()
  })

  it('keeps the rail and the thread side by side on desktop', async () => {
    renderTeam()
    await screen.findByRole('button', { name: '#general' })
    // The thread header renders alongside the channel list, with no back arrow.
    expect(await screen.findByText('#general', { selector: 'span' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back to channels' })).not.toBeInTheDocument()
  })

  it('on a phone, opening a channel replaces the rail with the thread pane', async () => {
    setViewport(true)
    renderTeam()
    const general = await screen.findByRole('button', { name: '#general' })

    // List pane only: no thread, so no composer.
    expect(screen.queryByPlaceholderText(/^Message /)).not.toBeInTheDocument()

    fireEvent.click(general)
    expect(await screen.findByPlaceholderText('Message #general')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /channels/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to channels' }))
    expect(screen.getByRole('tab', { name: /channels/i })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Message #general')).not.toBeInTheDocument()
  })

  it('persists the open channel and restores it on remount', async () => {
    renderTeam()
    fireEvent.click(await screen.findByRole('button', { name: '#zmrng' }))
    await waitFor(() => expect(localStorage.getItem('zmrng-team-open-channel')).toBe('2'))
  })

  it('on a phone, a persisted channel lands straight in its thread', async () => {
    localStorage.setItem('zmrng-team-open-channel', '2')
    setViewport(true)
    renderTeam()
    expect(await screen.findByPlaceholderText('Message #zmrng')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /channels/i })).not.toBeInTheDocument()
  })
})
