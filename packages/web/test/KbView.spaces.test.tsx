import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { KbView } from '../src/components/KbView'
import type { Space } from '../src/types'

const getSpaces = vi.fn()
const getSpaceTree = vi.fn()
const createSpace = vi.fn()
const deleteSpace = vi.fn()

vi.mock('../src/api', () => ({
  api: {
    getSpaces: (...a: unknown[]) => getSpaces(...a),
    getSpaceTree: (...a: unknown[]) => getSpaceTree(...a),
    createSpace: (...a: unknown[]) => createSpace(...a),
    deleteSpace: (...a: unknown[]) => deleteSpace(...a),
  },
}))

function space(id: number, name: string): Space {
  return {
    id,
    name,
    repoUrl: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

const SEED: Space[] = [space(1, 'general'), space(2, 'zmrng'), space(3, 'example-app')]

beforeEach(() => {
  getSpaces.mockResolvedValue(SEED)
  getSpaceTree.mockResolvedValue([])
  createSpace.mockReset()
  deleteSpace.mockReset()
})
afterEach(() => {
  // Clear call history only — never restoreAllMocks() here. Restoring resets
  // these plain vi.fn()s to return `undefined`, so any passive effect that
  // flushes after teardown would see `api.getSpaceTree(...)` hand back
  // undefined instead of a promise. The window spies created inside individual
  // tests are re-created by each test that needs one.
  vi.clearAllMocks()
})

/** Render the KB view (inactive, so no workspace socket opens) and wait for the
 *  seeded spaces to load into the switcher.
 *
 *  Waiting on the switcher alone is not enough: resolving getSpaces sets
 *  spaceId, which schedules a SECOND passive effect loading that space's tree.
 *  Leaving it pending at teardown is exactly the race that made this file flake
 *  under CPU contention, so wait for the tree load to have started too. */
async function renderKb(teamHandle: string) {
  render(<KbView teamHandle={teamHandle} onHandleChange={() => {}} active={false} />)
  await screen.findByRole('button', { name: 'general' })
  await waitFor(() => expect(getSpaceTree).toHaveBeenCalled())
}

describe('<KbView> spaces — create/delete affordances', () => {
  it('shows the "New space" button only when the user has an edit handle', async () => {
    await renderKb('Ada')
    expect(screen.getByRole('button', { name: 'New space' })).toBeInTheDocument()
  })

  it('hides the "New space" button for a read-only viewer (no handle)', async () => {
    await renderKb('')
    expect(screen.queryByRole('button', { name: 'New space' })).not.toBeInTheDocument()
  })

  it('offers a delete button on the selected space but NEVER on the protected zmrng space', async () => {
    await renderKb('Ada')
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
    await renderKb('Ada')

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
    await renderKb('Ada')

    fireEvent.click(screen.getByRole('button', { name: 'Delete the general space' }))

    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(deleteSpace).not.toHaveBeenCalled()
  })

  it('creates a space from the prompt and adds it to the switcher', async () => {
    createSpace.mockResolvedValue(space(4, 'Team Notes'))
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Team Notes')
    await renderKb('Ada')

    fireEvent.click(screen.getByRole('button', { name: 'New space' }))

    await waitFor(() => expect(createSpace).toHaveBeenCalledWith('Team Notes'))
    expect(promptSpy).toHaveBeenCalledOnce()
    await screen.findByRole('button', { name: 'Team Notes' })
  })
})
