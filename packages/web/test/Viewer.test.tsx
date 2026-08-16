import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Viewer } from '../src/components/Viewer'
import type { WorktreeFileContent } from '../src/types'

// CodeMirror + pdf.js are heavy and lazy-loaded — stub both so the Viewer's
// dispatch logic (editor vs. rendered preview) is what's under test.
vi.mock('../src/components/CodeEditor', () => ({
  CodeEditor: ({ initialValue }: { initialValue: string }) => (
    <textarea data-testid="code-editor" defaultValue={initialValue} />
  ),
}))
vi.mock('../src/components/PdfViewer', () => ({
  PdfViewer: () => <div data-testid="pdf-viewer" />,
}))

const readFile = vi.fn()
const readProjectFile = vi.fn()
vi.mock('../src/api', () => ({
  api: {
    readFile: (...a: unknown[]) => readFile(...a),
    readProjectFile: (...a: unknown[]) => readProjectFile(...a),
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
  })

  it('reads from the Projects dir (read-only) when no task is selected', async () => {
    readProjectFile.mockResolvedValue(fileOf('code', 'const x = 1'))
    render(<Viewer taskId={null} path="zmrng/README.md" />)

    await screen.findByTestId('code-editor')
    // No-task files come from the projects endpoint, never the task endpoint…
    expect(readProjectFile).toHaveBeenCalledWith('zmrng/README.md')
    expect(readFile).not.toHaveBeenCalled()
    // …and are read-only, so there is no Save control.
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    expect(screen.getByText('read-only')).toBeInTheDocument()
  })

  it('opens a markdown file in the editor (not a split) with a toggle to the preview', async () => {
    readFile.mockResolvedValue(fileOf('markdown', '# Heading'))
    render(<Viewer taskId="t1" path="notes.md" />)

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
    readFile.mockResolvedValue(fileOf('code', 'const x = 1'))
    render(<Viewer taskId="t1" path="a.ts" />)

    await screen.findByTestId('code-editor')
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
  })

  it('renders image and pdf read-only, with no editor or toggle', async () => {
    readFile.mockResolvedValue(fileOf('pdf', 'base64data'))
    const { unmount } = render(<Viewer taskId="t1" path="doc.pdf" />)
    await screen.findByTestId('pdf-viewer')
    expect(screen.queryByTestId('code-editor')).toBeNull()
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
    unmount()

    readFile.mockResolvedValue(fileOf('image', 'base64img'))
    render(<Viewer taskId="t1" path="pic.png" />)
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument())
    expect(screen.queryByTestId('code-editor')).toBeNull()
    expect(screen.queryByRole('button', { name: /preview/i })).toBeNull()
  })
})
