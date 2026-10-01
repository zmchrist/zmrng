import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TerminalCard } from '../src/components/TerminalCard'
import { closeTerminal } from '../src/terminalClose'
import type { TabsState, TerminalTabState } from '../src/windowTabs'

vi.mock('../src/components/Terminal', () => ({ Terminal: () => null }))
vi.mock('../src/terminalClose', () => ({ closeTerminal: vi.fn() }))

describe('TerminalCard tab ×', () => {
  it('kills the tab\'s PTY and removes the tab', () => {
    const tabs: TabsState<TerminalTabState> = { tabs: [{ id: 't1', label: 'Terminal 1' }], activeId: 't1' }
    const onTabsChange = vi.fn()
    render(<TerminalCard tabs={tabs} onTabsChange={onTabsChange} />)
    fireEvent.click(screen.getByLabelText('Close Terminal 1'))
    expect(closeTerminal).toHaveBeenCalledWith('t1')
    expect(onTabsChange).toHaveBeenCalledWith({ tabs: [], activeId: null })
  })
})
