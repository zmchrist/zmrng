import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BottomNav } from '../src/components/BottomNav'
import { hydrateGrid } from '../src/gridLayout'

describe('<BottomNav> Cards menu', () => {
  it('opens on click and closes when clicking outside the menu', () => {
    render(
      <BottomNav
        grid={hydrateGrid(null)}
        onGridChange={() => {}}
        settingsOpen={false}
        onSettingsToggle={() => {}}
        connected
      />,
    )

    const cardsBtn = screen.getByRole('button', { name: /cards/i })
    fireEvent.click(cardsBtn)
    expect(cardsBtn).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // The full-viewport scrim is what actually catches an "anywhere else" click.
    fireEvent.click(screen.getByRole('button', { name: /close cards menu/i }))
    expect(cardsBtn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not close when clicking inside the menu (toggling a card)', () => {
    const onGridChange = vi.fn()
    render(
      <BottomNav
        grid={hydrateGrid(null)}
        onGridChange={onGridChange}
        settingsOpen={false}
        onSettingsToggle={() => {}}
        connected
      />,
    )

    const cardsBtn = screen.getByRole('button', { name: /^cards/i })
    fireEvent.click(cardsBtn)
    const checkbox = screen.getAllByRole('checkbox')[0]
    fireEvent.click(checkbox)

    expect(onGridChange).toHaveBeenCalledTimes(1)
    expect(cardsBtn).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
