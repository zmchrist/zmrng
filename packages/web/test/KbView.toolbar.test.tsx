import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { KbView } from '../src/components/KbView'
import type { KbPage, KbTreeNode, Space } from '../src/types'

const getSpaces = vi.fn()
const getSpaceTree = vi.fn()
const getPage = vi.fn()
const openExternal = vi.fn()

vi.mock('../src/api', () => ({
  api: {
    getSpaces: (...a: unknown[]) => getSpaces(...a),
    getSpaceTree: (...a: unknown[]) => getSpaceTree(...a),
    getPage: (...a: unknown[]) => getPage(...a),
  },
}))

vi.mock('../src/openExternal', () => ({
  openExternal: (...a: unknown[]) => openExternal(...a),
}))

const SPACE: Space = {
  id: 1,
  name: 'general',
  repoUrl: null,
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const NODE: KbTreeNode = {
  id: 10,
  name: 'Notes',
  path: 'page/10',
  type: 'file',
  kind: 'page',
}

const PAGE: KbPage = {
  id: 10,
  spaceId: 1,
  folderId: null,
  title: 'Notes',
  body: 'hello world',
  author: 'Ada',
  updatedBy: 'Ada',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

beforeEach(() => {
  getSpaces.mockResolvedValue([SPACE])
  getSpaceTree.mockResolvedValue([NODE])
  getPage.mockResolvedValue(PAGE)
})
afterEach(() => {
  // Clear call history only — never restoreAllMocks() here (see the note in
  // KbView.spaces.test.tsx: a restored mock hands back `undefined` to any
  // passive effect that flushes after teardown).
  vi.clearAllMocks()
})

/** Render the KB view (inactive → no workspace socket) and open the seeded page. */
async function openPage(teamHandle: string, body = PAGE.body) {
  getPage.mockResolvedValue({ ...PAGE, body })
  render(<KbView teamHandle={teamHandle} onHandleChange={() => {}} active={false} />)
  await screen.findByRole('button', { name: 'general' })
  fireEvent.click(await screen.findByRole('button', { name: 'Notes' }))
  await waitFor(() => expect(getPage).toHaveBeenCalledWith(10))
  await screen.findByRole('heading', { name: 'Notes' })
}

describe('<KbView> formatting toolbar', () => {
  it('shows no toolbar in read mode and reveals it once the body is clicked', async () => {
    await openPage('Ada')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('hello world'))

    const textarea = await screen.findByLabelText('Page body')
    expect(textarea).toBeInTheDocument()
    expect(screen.getByRole('toolbar')).toBeInTheDocument()
  })

  it('applies a toolbar action to the textarea selection WITHOUT leaving edit mode', async () => {
    await openPage('Ada')
    fireEvent.click(screen.getByText('hello world'))

    const textarea = (await screen.findByLabelText('Page body')) as HTMLTextAreaElement
    textarea.setSelectionRange(0, 5)
    fireEvent.select(textarea)

    const bold = screen.getByRole('button', { name: 'Bold' })
    // The mousedown guard is what keeps the textarea focused; without it the
    // textarea's onBlur exits edit mode before the click ever lands.
    expect(fireEvent.mouseDown(bold)).toBe(false)
    fireEvent.click(bold)

    await waitFor(() => expect(textarea).toHaveValue('**hello** world'))
    // Still editing: the textarea and the toolbar are both still mounted.
    expect(screen.getByLabelText('Page body')).toBeInTheDocument()
    expect(screen.getByRole('toolbar')).toBeInTheDocument()
  })

  it('never shows the toolbar to a read-only viewer (no edit handle)', async () => {
    await openPage('')
    fireEvent.click(screen.getByText('hello world'))

    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Page body')).not.toBeInTheDocument()
  })

  it('opens a rendered link externally instead of dropping into the editor', async () => {
    await openPage('Ada', '[site](https://example.test/docs)')

    fireEvent.click(screen.getByRole('link', { name: 'site' }))

    expect(openExternal).toHaveBeenCalledWith('https://example.test/docs')
    // The click is swallowed — it must NOT enter edit mode.
    expect(screen.queryByLabelText('Page body')).not.toBeInTheDocument()
  })

  it('swallows a relative link without trying to open the app itself', async () => {
    await openPage('Ada', '[local](/some/page)')

    fireEvent.click(screen.getByRole('link', { name: 'local' }))

    expect(openExternal).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Page body')).not.toBeInTheDocument()
  })
})
