import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { KbView } from '../src/components/KbView'
import App from '../src/App'
import { loadSession, saveSession } from '../src/auth'
import type {
  KbChangeAction,
  KbChangeEntry,
  KbPage,
  KbTreeNode,
  PublicUser,
  Space,
} from '../src/types'

const getSpaces = vi.fn()
const getSpaceTree = vi.fn()
const createSpace = vi.fn()
const deleteSpace = vi.fn()
const getPage = vi.fn()
const getChangelog = vi.fn()
const logout = vi.fn()

/**
 * `api` is mocked for the KB calls this file exercises, PLUS the handful of
 * boot calls `<App/>` makes — the gating test below renders the real App, so
 * the assertion is about production wiring rather than a restated
 * `loadSession` check. `isAuthError` is re-exported too: KbView imports it from
 * this module to tell an expired session from a real failure.
 */
vi.mock('../src/api', () => ({
  isAuthError: (err: unknown) => err instanceof Error && err.name === 'AuthError',
  api: {
    getSpaces: (...a: unknown[]) => getSpaces(...a),
    getSpaceTree: (...a: unknown[]) => getSpaceTree(...a),
    createSpace: (...a: unknown[]) => createSpace(...a),
    deleteSpace: (...a: unknown[]) => deleteSpace(...a),
    getPage: (...a: unknown[]) => getPage(...a),
    getChangelog: (...a: unknown[]) => getChangelog(...a),
    logout: (...a: unknown[]) => logout(...a),
    // ---- App boot calls (never asserted on; just enough to mount) ----
    getConfig: () => Promise.resolve({ botHandle: '@agent' }),
    listRepos: () => Promise.resolve([]),
    listTasks: () => Promise.resolve([]),
    listChannels: () => Promise.resolve([]),
    getChannelMessages: () => Promise.resolve([]),
    // Boot the app straight onto the KB tab: App keeps every mode mounted and
    // hides the inactive ones with `display:none`, which Testing Library's role
    // queries (correctly) treat as inaccessible.
    getUiState: () => Promise.resolve({ global: { mode: 'kb' }, perTask: {} }),
    putUiState: () => Promise.resolve(),
  },
}))

// The task IDE is irrelevant here and would drag in the card grid, xterm and a
// live terminal socket. The CLI-auth banner would start a polling timer.
vi.mock('../src/components/WorkspaceView', () => ({
  WorkspaceView: () => <div data-testid="workspace-view" />,
}))
vi.mock('../src/components/AuthBanner', () => ({ AuthBanner: () => null }))
vi.mock('../src/useWs', () => ({ useWs: () => ({ connected: true }) }))

const ADA: PublicUser = { id: 1, username: 'ada', displayName: 'Ada' }

function space(id: number, name: string): Space {
  return {
    id,
    name,
    repoUrl: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

function pageNode(id: number, name: string): KbTreeNode {
  return { id, name, path: `page/${id}`, type: 'file', kind: 'page' }
}

function page(id: number, title: string): KbPage {
  return {
    id,
    spaceId: 1,
    folderId: null,
    title,
    body: 'the body',
    author: 'Ada',
    updatedBy: 'Ada',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

function entry(
  id: number,
  username: string,
  action: KbChangeAction,
  detail: string,
  createdAt: string,
): KbChangeEntry {
  return { id, spaceId: 1, pageId: 5, userId: 1, username, action, detail, createdAt }
}

/** A live session for the same-origin (Knowledge Base) server. */
function seedKbSession(): void {
  saveSession('', {
    user: ADA,
    token: 'kb-token',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  })
}

const SEED: Space[] = [space(1, 'general'), space(2, 'zmrng'), space(3, 'example-app')]

/**
 * A hand-rolled WebSocket double — the environment's own would dial a real
 * host, and the hermetic-test rule forbids any network. Only the surface
 * KbView touches is implemented.
 */
class FakeSocket {
  static readonly OPEN = 1
  static last: FakeSocket | null = null
  readyState = FakeSocket.OPEN
  closed = false
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.last = this
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.onclose?.()
  }
}

beforeEach(() => {
  localStorage.clear()
  getSpaces.mockResolvedValue(SEED)
  getSpaceTree.mockResolvedValue([])
  getPage.mockReset()
  getChangelog.mockReset()
  createSpace.mockReset()
  deleteSpace.mockReset()
  logout.mockReset()
  logout.mockResolvedValue({ ok: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  FakeSocket.last = null
  // Clear call history only — never restoreAllMocks() here. Restoring resets
  // these plain vi.fn()s to return `undefined`, so any passive effect that
  // flushes after teardown would see `api.getSpaceTree(...)` hand back
  // undefined instead of a promise. The window spies created inside individual
  // tests are re-created by each test that needs one.
  vi.clearAllMocks()
})

/** Render the KB view for an authenticated user (inactive, so no workspace
 *  socket opens) and wait for the seeded spaces to load into the switcher.
 *
 *  Waiting on the switcher alone is not enough: resolving getSpaces sets
 *  spaceId, which schedules a SECOND passive effect loading that space's tree.
 *  Leaving it pending at teardown is exactly the race that made this file flake
 *  under CPU contention, so wait for the tree load to have started too. */
async function renderKb(onLogout: () => void = () => {}) {
  render(<KbView user={ADA} onLogout={onLogout} active={false} />)
  await screen.findByRole('button', { name: 'general' })
  await waitFor(() => expect(getSpaceTree).toHaveBeenCalled())
}

describe('KB gating — the surface sits behind the login for its own origin', () => {
  it('renders the login pane instead of the KB tree when the local origin has no session', async () => {
    render(<App />)

    expect(
      await screen.findByRole('form', { name: /log in to knowledge base/i }),
    ).toBeInTheDocument()
    // The tree is not merely hidden — an unauthenticated KbView never mounts,
    // so it never even asks the server for spaces.
    expect(screen.queryByRole('button', { name: 'general' })).not.toBeInTheDocument()
    expect(getSpaces).not.toHaveBeenCalled()
  })

  it('renders the KB tree, not the login pane, once that origin has a session', async () => {
    seedKbSession()

    render(<App />)

    expect(await screen.findByRole('button', { name: 'general' })).toBeInTheDocument()
    expect(
      screen.queryByRole('form', { name: /log in to knowledge base/i }),
    ).not.toBeInTheDocument()
  })
})

describe('<KbView> authenticated — editing is enabled', () => {
  it('renders the tree with every write affordance available to an authenticated user', async () => {
    await renderKb()

    // Editing is simply "is authenticated" now — there is no handle to set and
    // no read-only branch left to fall into.
    expect(screen.getByRole('button', { name: 'New space' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New page' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New folder' })).toBeInTheDocument()
    // The authenticated identity is shown, with a way out.
    expect(screen.getByText('Ada')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /log out/i })).toBeInTheDocument()
  })

  it('logs out through the API and tells the parent to re-gate the surface', async () => {
    const onLogout = vi.fn()
    await renderKb(onLogout)

    fireEvent.click(screen.getByRole('button', { name: /log out/i }))

    await waitFor(() => expect(logout).toHaveBeenCalledWith(''))
    await waitFor(() => expect(onLogout).toHaveBeenCalled())
  })

  it('re-gates the surface when the socket reports the session is unauthorized', async () => {
    // The server closes a socket whose handshake presented no valid session.
    // Clearing the STORE is what actually re-gates: the stored session still
    // looks live by its own clock, so telling App to re-read without dropping
    // it would simply re-render this view behind a dead socket.
    seedKbSession()
    const onLogout = vi.fn()
    vi.stubGlobal('WebSocket', FakeSocket)

    render(<KbView user={ADA} onLogout={onLogout} active />)
    // Let the passive space/tree loads settle first, so the only state update
    // left to observe is the one the frame causes.
    await screen.findByRole('button', { name: 'general' })
    await waitFor(() => expect(getSpaceTree).toHaveBeenCalled())
    await waitFor(() => expect(FakeSocket.last).not.toBeNull())

    act(() => {
      FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: 'unauthorized' }) })
    })

    expect(onLogout).toHaveBeenCalled()
    expect(loadSession('')).toBeNull()
    expect(FakeSocket.last?.closed).toBe(true)
  })

  it('re-gates the surface (rather than showing an error) when a call 401s', async () => {
    const expired = new Error('your session has expired — please log in again')
    expired.name = 'AuthError'
    getSpaces.mockRejectedValueOnce(expired)
    const onLogout = vi.fn()

    render(<KbView user={ADA} onLogout={onLogout} active={false} />)

    await waitFor(() => expect(onLogout).toHaveBeenCalled())
    expect(screen.queryByText('Failed to load spaces')).not.toBeInTheDocument()
  })
})

describe('<KbView> changelog panel', () => {
  it('fetches the space changelog and lists its entries newest first', async () => {
    getSpaceTree.mockResolvedValue([pageNode(5, 'Notes')])
    getPage.mockResolvedValue(page(5, 'Notes'))
    getChangelog.mockResolvedValue([
      entry(2, 'grace', 'page.rename', 'Notes → Meeting notes', '2026-09-20T10:00:00.000Z'),
      entry(1, 'ada', 'page.create', 'Notes', '2026-09-19T10:00:00.000Z'),
    ])
    await renderKb()

    // The changelog sits with the other page actions, next to History.
    fireEvent.click(await screen.findByRole('button', { name: 'Notes' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Changelog' }))

    const panel = await screen.findByRole('dialog', { name: /changelog/i })
    await waitFor(() => expect(getChangelog).toHaveBeenCalledWith(1))
    expect(within(panel).getByText(/Notes → Meeting notes/)).toBeInTheDocument()
    expect(within(panel).getByText(/grace/)).toBeInTheDocument()
    expect(within(panel).getByText(/ada/)).toBeInTheDocument()
    // Server order is preserved (newest first) — the rename precedes the create.
    const rows = within(panel).getAllByRole('listitem')
    expect(rows[0].textContent).toMatch(/grace/)
    expect(rows[1].textContent).toMatch(/ada/)
  })

  it('closes the changelog panel again', async () => {
    getSpaceTree.mockResolvedValue([pageNode(5, 'Notes')])
    getPage.mockResolvedValue(page(5, 'Notes'))
    getChangelog.mockResolvedValue([])
    await renderKb()

    fireEvent.click(await screen.findByRole('button', { name: 'Notes' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Changelog' }))
    const panel = await screen.findByRole('dialog', { name: /changelog/i })

    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /changelog/i })).not.toBeInTheDocument(),
    )
  })
})

describe('<KbView> spaces — create/delete affordances', () => {
  it('offers a delete button on the selected space but NEVER on the protected zmrng space', async () => {
    await renderKb()
    // general is selected by default and is deletable.
    expect(
      screen.getByRole('button', { name: 'Delete the general space' }),
    ).toBeInTheDocument()

    // Select the protected zmrng space — no delete affordance appears for it.
    fireEvent.click(screen.getByRole('button', { name: 'zmrng' }))
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Delete the zmrng space' }),
      ).not.toBeInTheDocument()
    })
    // And the previously-selected space's delete button is gone (delete is
    // scoped to the currently selected space only).
    expect(
      screen.queryByRole('button', { name: 'Delete the general space' }),
    ).not.toBeInTheDocument()
  })

  it('deletes the selected space after a confirmation and drops it from the switcher', async () => {
    deleteSpace.mockResolvedValue(undefined)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderKb()

    fireEvent.click(screen.getByRole('button', { name: 'Delete the general space' }))

    await waitFor(() => expect(deleteSpace).toHaveBeenCalledWith(1))
    expect(confirmSpy).toHaveBeenCalledOnce()
    // The deleted space leaves the switcher.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'general' })).not.toBeInTheDocument(),
    )
  })

  it('does not delete when the confirmation is dismissed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await renderKb()

    fireEvent.click(screen.getByRole('button', { name: 'Delete the general space' }))

    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(deleteSpace).not.toHaveBeenCalled()
  })

  it('creates a space from the prompt and adds it to the switcher', async () => {
    createSpace.mockResolvedValue(space(4, 'Team Notes'))
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Team Notes')
    await renderKb()

    fireEvent.click(screen.getByRole('button', { name: 'New space' }))

    await waitFor(() => expect(createSpace).toHaveBeenCalledWith('Team Notes'))
    expect(promptSpy).toHaveBeenCalledOnce()
    await screen.findByRole('button', { name: 'Team Notes' })
  })
})
