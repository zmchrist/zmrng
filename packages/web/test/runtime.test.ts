import { describe, expect, it } from 'vitest'
import { isTauriRuntime } from '../src/runtime'

describe('isTauriRuntime', () => {
  it('is false for the plain browser dev view (no __TAURI__ global)', () => {
    expect(isTauriRuntime({})).toBe(false)
    expect(isTauriRuntime(undefined)).toBe(false)
  })

  it('is true when the native Tauri app exposes window.__TAURI__', () => {
    expect(isTauriRuntime({ __TAURI__: {} })).toBe(true)
  })

  it('is false when __TAURI__ is present but falsy', () => {
    expect(isTauriRuntime({ __TAURI__: undefined })).toBe(false)
  })
})
