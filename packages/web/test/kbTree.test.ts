import { describe, it, expect } from 'vitest'
import {
  parseKbNodePath,
  filterKbTree,
  collectFolders,
  pageBreadcrumb,
} from '../src/kbTree'
import type { KbTreeNode } from '../src/types'

const page = (id: number, name: string): KbTreeNode => ({
  id,
  name,
  path: `page/${id}`,
  type: 'file',
  kind: 'page',
})
const folder = (id: number, name: string, children: KbTreeNode[]): KbTreeNode => ({
  id,
  name,
  path: `folder/${id}`,
  type: 'dir',
  kind: 'folder',
  children,
})

const tree: KbTreeNode[] = [
  folder(1, 'Design', [
    page(10, 'Overview'),
    folder(2, 'Specs', [page(11, 'API spec'), page(12, 'DB spec')]),
  ]),
  page(13, 'Readme'),
]

describe('parseKbNodePath', () => {
  it('parses a page path to its ref', () => {
    expect(parseKbNodePath('page/12')).toEqual({ kind: 'page', id: 12 })
  })
  it('parses a folder path to its ref', () => {
    expect(parseKbNodePath('folder/3')).toEqual({ kind: 'folder', id: 3 })
  })
  it('rejects an unknown kind, a non-numeric id, or a missing slash', () => {
    expect(parseKbNodePath('space/1')).toBeNull()
    expect(parseKbNodePath('page/abc')).toBeNull()
    expect(parseKbNodePath('page/0')).toBeNull()
    expect(parseKbNodePath('page')).toBeNull()
  })
})

describe('filterKbTree', () => {
  it('returns the tree unchanged for an empty query', () => {
    expect(filterKbTree(tree, '   ')).toBe(tree)
  })
  it('keeps only matching pages plus their folder ancestors', () => {
    const out = filterKbTree(tree, 'spec')
    // Design folder kept (ancestor), Specs folder kept, both spec pages kept,
    // Overview + Readme dropped.
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Design')
    expect(out[0].children).toHaveLength(1)
    const specs = out[0].children![0]
    expect(specs.name).toBe('Specs')
    expect(specs.children!.map((c) => c.name)).toEqual(['API spec', 'DB spec'])
  })
  it('is case-insensitive and matches a root page', () => {
    const out = filterKbTree(tree, 'README')
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Readme')
  })
  it('keeps a whole folder subtree when the folder name matches', () => {
    const out = filterKbTree(tree, 'design')
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Design')
    expect(out[0].children).toHaveLength(2)
  })
})

describe('collectFolders', () => {
  it('flattens every folder depth-first with a name trail', () => {
    expect(collectFolders(tree)).toEqual([
      { id: 1, name: 'Design', path: 'Design' },
      { id: 2, name: 'Specs', path: 'Design / Specs' },
    ])
  })
})

describe('pageBreadcrumb', () => {
  it('builds the folder trail to a nested page', () => {
    expect(pageBreadcrumb(tree, 12)).toEqual(['Design', 'Specs'])
  })
  it('is empty for a root page', () => {
    expect(pageBreadcrumb(tree, 13)).toEqual([])
  })
  it('is empty for an unknown page', () => {
    expect(pageBreadcrumb(tree, 999)).toEqual([])
  })
})
