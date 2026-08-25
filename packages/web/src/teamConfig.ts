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
 * Build the `/ws/workspace` socket URL from a configured base. A bare origin
 * gets the path appended; a URL that already targets `/ws/workspace` is left
 * as-is. Returns '' for a blank base (nothing configured yet).
 */
export function workspaceSocketUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return trimmed.endsWith('/ws/workspace') ? trimmed : `${trimmed}/ws/workspace`
}
