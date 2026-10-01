import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { KbView } from '../src/components/KbView'

const getSpaces = vi.fn()
const getSpaceTree = vi.fn()

vi.mock('../src/api', () => ({
  api: {
    getSpaces: (...a: unknown[]) => getSpaces(...a),
    getSpaceTree: (...a: unknown[]) => getSpaceTree(...a),
  },
}))

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

beforeEach(() => {
  localStorage.clear()
  getSpaces.mockResolvedValue([
    { id: 1, name: 'general', repoUrl: null, createdAt: '', updatedAt: '' },
  ])
  getSpaceTree.mockResolvedValue([])
})
afterEach(() => {
  vi.clearAllMocks()
  setViewport(false)
})

async function renderKb() {
  const r = render(<KbView teamHandle="Ada" onHandleChange={() => {}} active={false} />)
  await screen.findByRole('button', { name: 'general' })
  await waitFor(() => expect(getSpaceTree).toHaveBeenCalled())
  return r
}

function handle() {
  return screen.getByRole('button', { name: /page list/i })
}
function swipe(from: number, to: number) {
  fireEvent.touchStart(handle(), { touches: [{ clientY: from }] })
  fireEvent.touchEnd(handle(), { changedTouches: [{ clientY: to }] })
}

describe('<KbView> phone list/page swipe handle', () => {
  it('has no handle on desktop', async () => {
    setViewport(false)
    await renderKb()
    expect(screen.queryByRole('button', { name: /page list/i })).not.toBeInTheDocument()
  })

  it('steps between full list, half and full page, and persists its own position', async () => {
    setViewport(true)
    const { unmount } = await renderKb()
    expect(handle()).toHaveAttribute('data-position', 'split')

    swipe(300, 200)
    expect(handle()).toHaveAttribute('data-position', 'detail')
    expect(document.querySelector('aside')).toHaveAttribute('aria-hidden', 'true')

    swipe(200, 300)
    swipe(200, 300)
    expect(handle()).toHaveAttribute('data-position', 'list')
    expect(document.querySelector('section')).toHaveAttribute('aria-hidden', 'true')
    expect(localStorage.getItem('zmrng-mobile-tasks-panel')).toBeNull()
    unmount()

    await renderKb()
    expect(handle()).toHaveAttribute('data-position', 'list')
  })
})
