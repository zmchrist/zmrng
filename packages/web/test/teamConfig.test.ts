import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadStoredWorkspaceUrl,
  saveStoredWorkspaceUrl,
  loadStoredHandle,
  saveStoredHandle,
  resolveWorkspaceUrl,
  workspaceSocketUrl,
  workspaceHttpOrigin,
} from '../src/teamConfig'

beforeEach(() => {
  localStorage.clear()
})

describe('workspace URL persistence', () => {
  it('round-trips a stored URL, trimming whitespace', () => {
    saveStoredWorkspaceUrl('  wss://vps.example  ')
    expect(loadStoredWorkspaceUrl()).toBe('wss://vps.example')
  })

  it('an empty/whitespace save clears the stored URL', () => {
    saveStoredWorkspaceUrl('wss://vps.example')
    saveStoredWorkspaceUrl('   ')
    expect(loadStoredWorkspaceUrl()).toBe('')
  })

  it('defaults to empty when nothing is stored', () => {
    expect(loadStoredWorkspaceUrl()).toBe('')
  })
})

describe('handle persistence', () => {
  it('round-trips a stored handle, trimming whitespace', () => {
    saveStoredHandle('  Ada  ')
    expect(loadStoredHandle()).toBe('Ada')
  })
})

describe('resolveWorkspaceUrl', () => {
  it('prefers the stored localStorage value over the server default', () => {
    saveStoredWorkspaceUrl('wss://mine.example')
    expect(resolveWorkspaceUrl('wss://server-default.example')).toBe('wss://mine.example')
  })

  it('falls back to the server default when nothing is stored', () => {
    expect(resolveWorkspaceUrl('wss://server-default.example')).toBe('wss://server-default.example')
  })

  it('returns empty when neither is set', () => {
    expect(resolveWorkspaceUrl('')).toBe('')
  })
})

describe('workspaceSocketUrl', () => {
  it('appends the /ws/workspace path to a bare base', () => {
    expect(workspaceSocketUrl('wss://vps.example')).toBe('wss://vps.example/ws/workspace')
  })

  it('strips a trailing slash before appending', () => {
    expect(workspaceSocketUrl('wss://vps.example/')).toBe('wss://vps.example/ws/workspace')
  })

  it('leaves a URL that already targets /ws/workspace untouched', () => {
    expect(workspaceSocketUrl('wss://vps.example/ws/workspace')).toBe(
      'wss://vps.example/ws/workspace',
    )
  })

  it('coerces http → ws and https → wss', () => {
    expect(workspaceSocketUrl('http://<vps-ip>:4500')).toBe(
      'ws://<vps-ip>:4500/ws/workspace',
    )
    expect(workspaceSocketUrl('https://vps.example')).toBe('wss://vps.example/ws/workspace')
  })

  it('defaults a scheme-less host to ws://', () => {
    expect(workspaceSocketUrl('<vps-ip>:4500')).toBe(
      'ws://<vps-ip>:4500/ws/workspace',
    )
  })

  it('returns empty for an empty base', () => {
    expect(workspaceSocketUrl('   ')).toBe('')
  })
})

describe('workspaceHttpOrigin', () => {
  it('keeps an http(s) base as its origin, dropping a /ws/workspace suffix', () => {
    expect(workspaceHttpOrigin('http://<vps-ip>:4500')).toBe('http://<vps-ip>:4500')
    expect(workspaceHttpOrigin('https://vps.example/ws/workspace')).toBe('https://vps.example')
  })

  it('coerces ws → http and wss → https', () => {
    expect(workspaceHttpOrigin('ws://<vps-ip>:4500/ws/workspace')).toBe(
      'http://<vps-ip>:4500',
    )
    expect(workspaceHttpOrigin('wss://vps.example')).toBe('https://vps.example')
  })

  it('defaults a scheme-less host to http://', () => {
    expect(workspaceHttpOrigin('<vps-ip>:4500')).toBe('http://<vps-ip>:4500')
  })

  it('returns empty for an empty base', () => {
    expect(workspaceHttpOrigin('   ')).toBe('')
  })
})
