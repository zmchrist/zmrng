import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const openMock = vi.fn()
vi.mock('@tauri-apps/plugin-shell', () => ({ open: openMock }))

describe('openExternal', () => {
  const originalOpen = window.open

  beforeEach(() => {
    openMock.mockReset()
    window.open = vi.fn()
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  afterEach(() => {
    window.open = originalOpen
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('falls back to window.open in the dev browser (no Tauri runtime)', async () => {
    const { openExternal } = await import('../src/openExternal')
    await openExternal('https://github.com/example/repo/pull/1')
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/example/repo/pull/1',
      '_blank',
      'noreferrer',
    )
    expect(openMock).not.toHaveBeenCalled()
  })

  it('routes through the Tauri shell plugin when running inside the desktop shell', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    const { openExternal } = await import('../src/openExternal')
    await openExternal('https://github.com/example/repo/pull/2')
    expect(openMock).toHaveBeenCalledWith('https://github.com/example/repo/pull/2')
    expect(window.open).not.toHaveBeenCalled()
  })

  it('falls back to window.open when the Tauri shell open() rejects (capability/scope gap)', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    openMock.mockRejectedValueOnce(new Error('shell.open not allowed on this origin'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { openExternal } = await import('../src/openExternal')
    await openExternal('https://github.com/example/repo/pull/3')
    expect(openMock).toHaveBeenCalledWith('https://github.com/example/repo/pull/3')
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/example/repo/pull/3',
      '_blank',
      'noreferrer',
    )
    errSpy.mockRestore()
  })
})
