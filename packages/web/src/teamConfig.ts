// Pure URL helpers for the Team tab's VPS workspace-server base. The workspace
// URL and the self-asserted display-name handle are now persisted server-side in
// `zmrng.db` (WorkspaceSettings, GET/PUT /api/settings) rather than browser
// localStorage, which proved unreliable across refresh/app-reopen/rebuild in the
// desktop shell. App merges the persisted value over the ServerConfig env
// default and hands the effective base to these transport coercers.

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
