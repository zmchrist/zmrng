import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MobileNav } from '../src/components/MobileNav'
import { MOBILE_VIEWS } from '../src/mobileNav'

function setup(overrides: Partial<Parameters<typeof MobileNav>[0]> = {}) {
  const props = {
    view: 'tasks' as const,
    drawerOpen: false,
    connected: true,
    onToggleDrawer: vi.fn(),
    onSelect: vi.fn(),
    onCloseDrawer: vi.fn(),
    onSettings: vi.fn(),
    ...overrides,
  }
  render(<MobileNav {...props} />)
  return props
}

describe('<MobileNav>', () => {
  it('shows the current view name and hides the drawer when closed', () => {
    setup({ view: 'terminal' })
    expect(screen.getByText('Terminal')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: /views/i })).not.toBeInTheDocument()
  })

  it('toggles the drawer from the hamburger', () => {
    const props = setup()
    const menu = screen.getByRole('button', { name: /menu/i })
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(menu)
    expect(props.onToggleDrawer).toHaveBeenCalled()
  })

  it('lists every view once the drawer is open and reports the picked one', () => {
    const props = setup({ drawerOpen: true })
    const nav = screen.getByRole('navigation', { name: /views/i })
    const labels = within(nav)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
    expect(labels).toEqual(MOBILE_VIEWS.map((v) => v.label))
    // Every entry draws an outline svg icon from the shared source — no text glyphs.
    within(nav)
      .getAllByRole('button')
      .forEach((b, i) => {
        expect(b.querySelector('svg')?.getAttribute('data-icon')).toBe(MOBILE_VIEWS[i].icon)
      })

    // Index looked up from the model, so adding a view never breaks this.
    const teamIndex = MOBILE_VIEWS.findIndex((v) => v.id === 'team')
    fireEvent.click(within(nav).getAllByRole('button')[teamIndex])
    expect(props.onSelect).toHaveBeenCalledWith('team')
  })

  it('marks the active entry and closes on the scrim', () => {
    const props = setup({ drawerOpen: true, view: 'kb' })
    const nav = screen.getByRole('navigation', { name: /views/i })
    const active = within(nav)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'page')
    expect(active).toHaveLength(1)
    expect(active[0].textContent).toContain('KB')
    fireEvent.click(screen.getByRole('button', { name: /close menu/i }))
    expect(props.onCloseDrawer).toHaveBeenCalled()
  })

  it('surfaces the connection state and a Settings gear', () => {
    const props = setup({ connected: false })
    expect(screen.getByLabelText('offline')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /settings/i }).querySelector('svg')?.getAttribute('data-icon'),
    ).toBe('settings')
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(props.onSettings).toHaveBeenCalled()
  })
})
