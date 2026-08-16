import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TerminalDock } from '../src/components/TerminalDock'

/** Dock rendered closed (no terminal mounted, so no `/ws/terminal` socket is
 *  opened) — enough to exercise the nav bar's pane toggles, including the
 *  new Files button. */
function renderDock(overrides: Partial<React.ComponentProps<typeof TerminalDock>> = {}) {
  const props: React.ComponentProps<typeof TerminalDock> = {
    open: false,
    height: 300,
    onOpenChange: vi.fn(),
    onHeightChange: vi.fn(),
    tasksOpen: false,
    workspaceOpen: false,
    filesOpen: true,
    settingsOpen: false,
    onTasksToggle: vi.fn(),
    onWorkspaceToggle: vi.fn(),
    onFilesToggle: vi.fn(),
    onSettingsToggle: vi.fn(),
    ...overrides,
  }
  return { ...render(<TerminalDock {...props} />), props }
}

describe('<TerminalDock> nav bar', () => {
  it('renders a Files toggle positioned after Workspace and before Settings', () => {
    renderDock()
    const buttons = screen.getAllByRole('button')
    const labels = buttons.map((b) => b.textContent)
    const workspaceIdx = labels.findIndex((l) => l?.includes('Workspace'))
    const filesIdx = labels.findIndex((l) => l?.includes('Files'))
    const settingsIdx = labels.findIndex((l) => l?.includes('Settings'))
    expect(workspaceIdx).toBeGreaterThanOrEqual(0)
    expect(filesIdx).toBeGreaterThan(workspaceIdx)
    expect(settingsIdx).toBeGreaterThan(filesIdx)
  })

  it('reflects filesOpen in aria-pressed and calls onFilesToggle when clicked', () => {
    const { props } = renderDock({ filesOpen: true })
    const filesBtn = screen.getByRole('button', { name: /hide files/i })
    expect(filesBtn).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(filesBtn)
    expect(props.onFilesToggle).toHaveBeenCalledTimes(1)
  })

  it('shows "Show files" when filesOpen is false', () => {
    renderDock({ filesOpen: false })
    expect(screen.getByRole('button', { name: /show files/i })).toBeInTheDocument()
  })
})
