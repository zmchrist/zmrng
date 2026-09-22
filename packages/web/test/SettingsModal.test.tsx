import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SettingsModal } from '../src/components/SettingsModal'

/**
 * The Team VPS base is fixed in code (`teamConfig.WORKSPACE_URL`) for every
 * install, so Settings deliberately carries no workspace-URL field: there is
 * nothing for a teammate to enter, and nothing a stale entry could break.
 */
describe('SettingsModal — team workspace URL', () => {
  it('renders no workspace-URL field', () => {
    render(<SettingsModal open onClose={() => undefined} connected />)
    expect(screen.queryByLabelText('Team workspace VPS URL')).toBeNull()
    expect(screen.queryByText('Team workspace')).toBeNull()
  })

  it('still renders the rest of the panel', () => {
    render(<SettingsModal open onClose={() => undefined} connected />)
    expect(screen.getByText('Reboot')).toBeInTheDocument()
  })
})
