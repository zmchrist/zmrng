import { describe, it, expect } from 'vitest'
import { WORKSPACE_URL, workspaceSocketUrl, workspaceHttpOrigin } from '../src/teamConfig'

describe('WORKSPACE_URL (the build-time VPS base)', () => {
  it('is a string, empty when VITE_WORKSPACE_URL is unset (as in the test env)', () => {
    expect(typeof WORKSPACE_URL).toBe('string')
    expect(WORKSPACE_URL).toBe('')
  })

  it('derives empty transports from an unconfigured (empty) base', () => {
    expect(workspaceSocketUrl(WORKSPACE_URL)).toBe('')
    expect(workspaceHttpOrigin(WORKSPACE_URL)).toBe('')
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
    expect(workspaceSocketUrl('http://vps.example:4500')).toBe(
      'ws://vps.example:4500/ws/workspace',
    )
    expect(workspaceSocketUrl('https://vps.example')).toBe('wss://vps.example/ws/workspace')
  })

  it('defaults a scheme-less host to ws://', () => {
    expect(workspaceSocketUrl('vps.example:4500')).toBe(
      'ws://vps.example:4500/ws/workspace',
    )
  })

  it('returns empty for an empty base', () => {
    expect(workspaceSocketUrl('   ')).toBe('')
  })
})

describe('workspaceHttpOrigin', () => {
  it('keeps an http(s) base as its origin, dropping a /ws/workspace suffix', () => {
    expect(workspaceHttpOrigin('http://vps.example:4500')).toBe('http://vps.example:4500')
    expect(workspaceHttpOrigin('https://vps.example/ws/workspace')).toBe('https://vps.example')
  })

  it('coerces ws → http and wss → https', () => {
    expect(workspaceHttpOrigin('ws://vps.example:4500/ws/workspace')).toBe(
      'http://vps.example:4500',
    )
    expect(workspaceHttpOrigin('wss://vps.example')).toBe('https://vps.example')
  })

  it('defaults a scheme-less host to http://', () => {
    expect(workspaceHttpOrigin('vps.example:4500')).toBe('http://vps.example:4500')
  })

  it('returns empty for an empty base', () => {
    expect(workspaceHttpOrigin('   ')).toBe('')
  })
})
