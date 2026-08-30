// Per-teammate Team-tab settings, persisted to localStorage (mirrors the
// `zmrng-*` key style in themes.ts). The VPS workspace-server URL is per-machine,
// so it lives client-side; an optional server default (ServerConfig.workspaceUrl)
// seeds it, but the stored value wins. The self-asserted display-name handle is
// remembered so a teammate is not re-prompted on every visit.

const URL_KEY = 'zmrng-workspace-url'
const HANDLE_KEY = 'zmrng-team-handle'

function loadKey(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function saveKey(key: string, value: string): void {
  try {
    const trimmed = value.trim()
    if (trimmed) localStorage.setItem(key, trimmed)
    else localStorage.removeItem(key)
  } catch {
    // localStorage unavailable (private mode, quota) — just won't persist.
  }
}

/** The stored VPS workspace-server URL, or '' when unset. */
export function loadStoredWorkspaceUrl(): string {
  return loadKey(URL_KEY)
}

/** Persist (or clear, when blank) the VPS workspace-server URL. */
export function saveStoredWorkspaceUrl(url: string): void {
  saveKey(URL_KEY, url)
}

/** The stored self-asserted display-name handle, or '' when unset. */
export function loadStoredHandle(): string {
  return loadKey(HANDLE_KEY)
}

/** Persist (or clear, when blank) the self-asserted display-name handle. */
export function saveStoredHandle(handle: string): void {
  saveKey(HANDLE_KEY, handle)
}

/**
 * The effective workspace URL: the per-teammate stored value wins over the
 * optional server-side default (from `ServerConfig.workspaceUrl`).
 */
export function resolveWorkspaceUrl(serverDefault: string): string {
  return loadStoredWorkspaceUrl() || serverDefault.trim()
}

/**
 * Strip a configured base down to a bare origin (scheme + host[:port]),
 * dropping any trailing slash(es) and a trailing `/ws/workspace` path. Returns
 * '' for a blank base. Scheme is left untouched here — the ws/http coercers
 * below normalize it for their respective transports.
 */
function baseOrigin(base: string): string {
  return base
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/ws\/workspace$/, '')
    .replace(/\/+$/, '')
}

/**
 * Build the `/ws/workspace` socket URL from a configured base. Accepts a bare
 * host, an http(s) URL, or a ws(s) URL and always yields a ws(s):// socket URL:
 * `http`→`ws`, `https`→`wss`, a scheme-less base defaults to `ws://`. Returns
 * '' for a blank base (nothing configured yet).
 */
export function workspaceSocketUrl(base: string): string {
  const origin = baseOrigin(base)
  if (!origin) return ''
  let wsBase: string
  if (/^wss:\/\//i.test(origin) || /^ws:\/\//i.test(origin)) {
    wsBase = origin
  } else if (/^https:\/\//i.test(origin)) {
    wsBase = origin.replace(/^https:\/\//i, 'wss://')
  } else if (/^http:\/\//i.test(origin)) {
    wsBase = origin.replace(/^http:\/\//i, 'ws://')
  } else {
    wsBase = `ws://${origin}`
  }
  return `${wsBase}/ws/workspace`
}

/**
 * Build the HTTP(S) origin for the VPS REST surface (channel list/create/
 * scrollback) from the same configured base. The channel data lives on the VPS
 * server, NOT the teammate's local server, so these REST calls must target the
 * VPS origin — otherwise a created channel lands in the local SQLite and no
 * teammate ever sees it. `ws`→`http`, `wss`→`https`, a scheme-less base
 * defaults to `http://`. Returns '' for a blank base.
 */
export function workspaceHttpOrigin(base: string): string {
  const origin = baseOrigin(base)
  if (!origin) return ''
  if (/^https:\/\//i.test(origin) || /^http:\/\//i.test(origin)) return origin
  if (/^wss:\/\//i.test(origin)) return origin.replace(/^wss:\/\//i, 'https://')
  if (/^ws:\/\//i.test(origin)) return origin.replace(/^ws:\/\//i, 'http://')
  return `http://${origin}`
}
