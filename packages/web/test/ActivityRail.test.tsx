import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ActivityRail } from '../src/components/ActivityRail'

const noop = () => undefined

describe('ActivityRail', () => {
  it('renders one button per mode plus Settings', () => {
    render(<ActivityRail mode="workspace" teamUnread={false} onSelect={noop} onSettings={noop} />)
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Team' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'KB' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('draws the Team icon as an outline svg bubble, not a unicode glyph', () => {
    const { container } = render(
      <ActivityRail mode="workspace" teamUnread={false} onSelect={noop} onSettings={noop} />,
    )
    const team = screen.getByRole('button', { name: 'Team' })
    const svg = team.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('fill')).toBe('none')
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    expect(container.textContent).not.toContain('🗨')
  })

  it('draws Workspace, KB and Settings as shared outline svgs, not text glyphs', () => {
    const { container } = render(
      <ActivityRail mode="workspace" teamUnread={false} onSelect={noop} onSettings={noop} />,
    )
    const expected: Array<[string, string]> = [
      ['Workspace', 'workspace'],
      ['Team', 'team'],
      ['KB', 'kb'],
      ['Settings', 'settings'],
    ]
    for (const [name, icon] of expected) {
      const svg = screen.getByRole('button', { name }).querySelector('svg')
      expect(svg?.getAttribute('data-icon')).toBe(icon)
      expect(svg?.getAttribute('stroke-width')).toBe('1.6')
    }
    expect(container.textContent).not.toMatch(/[≣❏⚙]/)
  })

  it('renders a Loop button with the loop outline icon, and selecting it reports loop', () => {
    const onSelect = vi.fn()
    render(<ActivityRail mode="workspace" teamUnread={false} onSelect={onSelect} onSettings={noop} />)
    const loop = screen.getByRole('button', { name: 'Loop' })
    expect(loop.querySelector('svg')?.getAttribute('data-icon')).toBe('loop')
    expect(loop).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(loop)
    expect(onSelect).toHaveBeenCalledWith('loop')
  })

  it('marks Loop pressed while the Loop mode is active', () => {
    render(<ActivityRail mode="loop" teamUnread={false} onSelect={noop} onSettings={noop} />)
    expect(screen.getByRole('button', { name: 'Loop' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('hides the unread orb by default', () => {
    render(<ActivityRail mode="workspace" teamUnread={false} onSelect={noop} onSettings={noop} />)
    expect(screen.queryByTestId('team-unread-orb')).toBeNull()
  })

  it('shows the unread orb on the Team icon and announces it', () => {
    render(<ActivityRail mode="workspace" teamUnread onSelect={noop} onSettings={noop} />)
    const orb = screen.getByTestId('team-unread-orb')
    expect(orb).toBeInTheDocument()
    const team = screen.getByRole('button', { name: 'Team — new messages' })
    expect(team).toContainElement(orb)
  })

  it('marks the active mode pressed', () => {
    render(<ActivityRail mode="team" teamUnread={false} onSelect={noop} onSettings={noop} />)
    expect(screen.getByRole('button', { name: 'Team' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'KB' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports clicks', () => {
    const onSelect = vi.fn()
    const onSettings = vi.fn()
    render(
      <ActivityRail mode="workspace" teamUnread={false} onSelect={onSelect} onSettings={onSettings} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Team' }))
    expect(onSelect).toHaveBeenCalledWith('team')
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSettings).toHaveBeenCalled()
  })
})
