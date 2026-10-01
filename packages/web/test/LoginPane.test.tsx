import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LoginPane } from '../src/components/LoginPane'
import { loadSession, type LoginPost } from '../src/auth'
import type { LoginResponse, PublicUser } from '../src/types'

const LOCAL = ''
const VPS = 'http://<vps-ip>:4500'

const ADA: PublicUser = { id: 1, username: 'ada', displayName: 'Ada' }

function ok(token: string): LoginResponse {
  return { user: ADA, token, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }
}

/** Fill both credential fields so the submit button becomes enabled. */
function fillCredentials(username = 'ada', password = 'hunter22') {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
}

const submitButton = () => screen.getByRole('button', { name: /log in/i })

beforeEach(() => {
  localStorage.clear()
})

describe('<LoginPane>', () => {
  it('renders a labelled username field and a masked password field', () => {
    render(<LoginPane origins={[LOCAL]} label="Knowledge Base" onAuthed={() => {}} post={vi.fn()} />)

    const username = screen.getByLabelText('Username')
    const password = screen.getByLabelText('Password')
    expect(username).toBeInTheDocument()
    expect(password).toBeInTheDocument()
    // The password must never be rendered in the clear.
    expect(password).toHaveAttribute('type', 'password')
    // The pane names the surface it is unlocking.
    expect(screen.getByText(/Knowledge Base/)).toBeInTheDocument()
  })

  it('keeps submit disabled until BOTH fields are non-empty', () => {
    render(<LoginPane origins={[LOCAL]} label="Knowledge Base" onAuthed={() => {}} post={vi.fn()} />)

    expect(submitButton()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } })
    expect(submitButton()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } })
    expect(submitButton()).toBeEnabled()

    // Blanking either field disables it again (whitespace is not a credential).
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: '   ' } })
    expect(submitButton()).toBeDisabled()
  })

  it('calls onAuthed with the stored sessions on a successful login', async () => {
    const onAuthed = vi.fn()
    const post = vi.fn<LoginPost>(async () => ok('local-token'))
    render(<LoginPane origins={[LOCAL]} label="Knowledge Base" onAuthed={onAuthed} post={post} />)

    fillCredentials()
    fireEvent.click(submitButton())

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith(LOCAL, { username: 'ada', password: 'hunter22' })
    const results = onAuthed.mock.calls[0][0]
    expect(results).toEqual([
      { origin: LOCAL, ok: true, session: { user: ADA, token: 'local-token', expiresAt: expect.any(String) } },
    ])
    expect(loadSession(LOCAL)?.token).toBe('local-token')
  })

  it('shows the server error on a rejected login and KEEPS the typed username', async () => {
    const onAuthed = vi.fn()
    const post = vi.fn<LoginPost>(async () => {
      throw new Error('Invalid username or password.')
    })
    render(<LoginPane origins={[LOCAL]} label="Knowledge Base" onAuthed={onAuthed} post={post} />)

    fillCredentials()
    fireEvent.click(submitButton())

    expect(await screen.findByText('Invalid username or password.')).toBeInTheDocument()
    expect(onAuthed).not.toHaveBeenCalled()
    // Retyping a username after a mistyped password is a real annoyance.
    expect(screen.getByLabelText('Username')).toHaveValue('ada')
  })

  it('disables submit while a login is in flight', async () => {
    let release: (value: LoginResponse) => void = () => {}
    const post = vi.fn<LoginPost>(
      () => new Promise<LoginResponse>((resolve) => { release = resolve }),
    )
    render(<LoginPane origins={[LOCAL]} label="Knowledge Base" onAuthed={() => {}} post={post} />)

    fillCredentials()
    fireEvent.click(submitButton())

    await waitFor(() => expect(submitButton()).toBeDisabled())
    // A second click while in flight must not fire a second request.
    fireEvent.click(submitButton())
    expect(post).toHaveBeenCalledTimes(1)

    release(ok('local-token'))
    await waitFor(() => expect(submitButton()).toBeEnabled())
  })

  it('submits on Enter — it is a real <form>, not a click handler', async () => {
    const onAuthed = vi.fn()
    const post = vi.fn<LoginPost>(async () => ok('local-token'))
    render(<LoginPane origins={[LOCAL]} label="Knowledge Base" onAuthed={onAuthed} post={post} />)

    fillCredentials()
    // Implicit submission (Enter in a text field) dispatches `submit` on the
    // form element itself, so wiring must live on the <form>'s onSubmit.
    fireEvent.submit(screen.getByRole('form', { name: /knowledge base/i }))

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1))
  })

  it('still authenticates the reachable origin when another fails, and names the gated one', async () => {
    const onAuthed = vi.fn()
    const post = vi.fn<LoginPost>(async (origin) => {
      if (origin === VPS) throw new Error('Failed to fetch')
      return ok('local-token')
    })
    render(
      <LoginPane origins={[LOCAL, VPS]} label="Knowledge Base" onAuthed={onAuthed} post={post} />,
    )

    fillCredentials()
    fireEvent.click(submitButton())

    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1))
    // The partial failure is surfaced inline, naming the origin still gated.
    expect(await screen.findByText(new RegExp(VPS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument()
    expect(loadSession(LOCAL)?.token).toBe('local-token')
  })
})
