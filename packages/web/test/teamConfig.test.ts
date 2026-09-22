import { describe, it, expect } from 'vitest'
import { WORKSPACE_URL, workspaceSocketUrl, workspaceHttpOrigin } from '../src/teamConfig'

describe('WORKSPACE_URL (the fixed VPS base)', () => {
  it('is the shared Tailscale VPS, fixed in code so nothing has to be entered', () => {
    expect(WORKSPACE_URL).toBe('http://<vps-ip>:4500')
  })

  it('derives a usable socket URL and REST origin with no configuration', () => {
    expect(workspaceSocketUrl(WORKSPACE_URL)).toBe('ws://<vps-ip>:4500/ws/workspace')
    expect(workspaceHttpOrigin(WORKSPACE_URL)).toBe('http://<vps-ip>:4500')
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
