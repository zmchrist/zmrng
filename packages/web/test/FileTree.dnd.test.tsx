import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileTree } from '../src/components/FileTree'
import type { WorktreeFileNode } from '../src/types'

// A KB-shaped tree (folders as dirs, pages as files) with `folder/<id>` /
// `page/<id>` paths — exactly what KbView feeds the tree for drag re-parenting.
//   folderA (folder/1)
//     pageX  (page/10)
//     folderB (folder/2)
//   pageY (page/20)
const tree: WorktreeFileNode[] = [
  {
    name: 'folderA',
    path: 'folder/1',
    type: 'dir',
    children: [
      { name: 'pageX', path: 'page/10', type: 'file' },
      { name: 'folderB', path: 'folder/2', type: 'dir', children: [] },
    ],
  },
  { name: 'pageY', path: 'page/20', type: 'file' },
]

/** A minimal DataTransfer stub — jsdom drag events carry none by default. */
function dt(): { dataTransfer: { effectAllowed: string; setData: () => void } } {
  return { dataTransfer: { effectAllowed: '', setData: vi.fn() } }
}

describe('FileTree drag-and-drop re-parenting', () => {
  it('drops a page onto a folder → onMove(sourcePath, folderPath)', () => {
    const onMove = vi.fn()
    render(<FileTree entries={tree} onOpen={() => {}} onMove={onMove} />)
    fireEvent.dragStart(screen.getByTitle('page/20'), dt())
    fireEvent.drop(screen.getByTitle('folder/1'), dt())
    expect(onMove).toHaveBeenCalledExactlyOnceWith('page/20', 'folder/1')
  })

  it('drops onto the tree root → onMove(sourcePath, null)', () => {
    const onMove = vi.fn()
    const { container } = render(<FileTree entries={tree} onOpen={() => {}} onMove={onMove} />)
    fireEvent.dragStart(screen.getByTitle('page/10'), dt())
    fireEvent.drop(container.firstElementChild as Element, dt())
    expect(onMove).toHaveBeenCalledExactlyOnceWith('page/10', null)
  })

  it('blocks dropping a folder onto its own descendant (cycle guard)', () => {
    const onMove = vi.fn()
    render(<FileTree entries={tree} onOpen={() => {}} onMove={onMove} />)
    // folderA is the ancestor of folderB — dropping A into B would create a cycle.
    fireEvent.dragStart(screen.getByTitle('folder/1'), dt())
    fireEvent.drop(screen.getByTitle('folder/2'), dt())
    expect(onMove).not.toHaveBeenCalled()
  })

  it('ignores a self-drop (folder onto itself)', () => {
    const onMove = vi.fn()
    render(<FileTree entries={tree} onOpen={() => {}} onMove={onMove} />)
    fireEvent.dragStart(screen.getByTitle('folder/1'), dt())
    fireEvent.drop(screen.getByTitle('folder/1'), dt())
    expect(onMove).not.toHaveBeenCalled()
  })

  it('renders no draggable rows when onMove is omitted (read-only Files tree)', () => {
    render(<FileTree entries={tree} onOpen={() => {}} />)
    expect(screen.getByTitle('page/20')).not.toHaveAttribute('draggable', 'true')
    expect(screen.getByTitle('folder/1')).not.toHaveAttribute('draggable', 'true')
  })
})
