import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Viewer } from '../src/components/Viewer'
import type { WorktreeFileContent } from '../src/types'

// CodeMirror + pdf.js are heavy and lazy-loaded — stub both so the Viewer's
// dispatch logic (editor vs. rendered preview) is what's under test.
vi.mock('../src/components/CodeEditor', () => ({
  CodeEditor: ({
    initialValue,
    onChange,
  }: {
    initialValue: string
    onChange: (v: string) => void
  }) => (
    <textarea
      data-testid="code-editor"
      defaultValue={initialValue}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))
vi.mock('../src/components/PdfViewer', () => ({
  PdfViewer: () => <div data-testid="pdf-viewer" />,
}))

const readFile = vi.fn()
const readProjectFile = vi.fn()
const writeProjectFile = vi.fn()
vi.mock('../src/api', () => ({
  api: {
    readFile: (...a: unknown[]) => readFile(...a),
    readProjectFile: (...a: unknown[]) => readProjectFile(...a),
    writeProjectFile: (...a: unknown[]) => writeProjectFile(...a),
  },
}))

function fileOf(format: WorktreeFileContent['format'], content: string): WorktreeFileContent {
  return {
    path: 'x',
    format,
    encoding: format === 'image' || format === 'pdf' ? 'base64' : 'utf8',
    content,
  }
}

describe('<Viewer>', () => {
  beforeEach(() => {
    readFile.mockReset()
    readProjectFile.mockReset()
    writeProjectFile.mockReset()
    writeProjectFile.mockResolvedValue({ ok: true })
  })

  it('always reads from the Projects dir, never a task worktree', async () => {
    readProjectFile.mockResolvedValue(fileOf('code', 'const x = 1'))
    render(<Viewer path="zmrng/README.md" />)

    await screen.findByTestId('code-editor')
    expect(readProjectFile).toHaveBeenCalledWith('zmrng/README.md')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('saves a Projects-dir text file through the projects write endpoint', async () => {
    readProjectFile.mockResolvedValue(fileOf('code', 'const x = 1'))
    render(<Viewer path="zmrng/a.ts" />)

    const editor = await screen.findByTestId('code-editor')
    // The Save control exists (Projects-dir text files are writable) and is
    // disabled until the draft actually diverges from the loaded content.
    const save = screen.getByRole('button', { name: /save/i })
    expect(save).toBeDisabled()
    expect(screen.queryByText('read-only')).toBeNull()

    fireEvent.change(editor, { target: { value: 'const x = 2' } })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)

    await waitFor(() => expect(writeProjectFile).toHaveBeenCalledWith('zmrng/a.ts', 'const x = 2'))
  })

  it('opens a markdown file in the editor (not a split) with a toggle to the preview', async () => {
    readProjectFile.mockResolvedValue(fileOf('markdown', '# Heading'))
    render(<Viewer path="notes.md" />)

    // Default view is the editor, and only the editor — no rendered preview.
    await screen.findByTestId('code-editor')
    expect(screen.queryByRole('heading', { name: 'Heading' })).toBeNull()

    // Toggle swaps to the rendered preview, hiding the editor.
    fireEvent.click(screen.getByRole('button', { name: /preview/i }))
    await screen.findByRole('heading', { name: 'Heading' })
    expect(screen.queryByTestId('code-editor')).toBeNull()

    // And back to the editor.
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    await screen.findByTestId('code-editor')
    expect(screen.queryByRole('heading', { name: 'Heading' })).toBeNull()
  })

  it('shows no preview toggle for a non-markdown code file', async () => {
    readProjectFile.mockResolvedValue(fileOf('code', 'const x = 1'))
    render(<Viewer path="a.ts" />)

    await screen.findByTestId('code-editor')
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
  })

  it('renders image and pdf read-only, with no editor or toggle', async () => {
    readProjectFile.mockResolvedValue(fileOf('pdf', 'base64data'))
    const { unmount } = render(<Viewer path="doc.pdf" />)
    await screen.findByTestId('pdf-viewer')
    expect(screen.queryByTestId('code-editor')).toBeNull()
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
    unmount()

    readProjectFile.mockResolvedValue(fileOf('image', 'base64img'))
    render(<Viewer path="pic.png" />)
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument())
    expect(screen.queryByTestId('code-editor')).toBeNull()
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
  })
})
