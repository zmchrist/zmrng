// Pure URL helpers for the Team tab's VPS workspace-server base, plus the base
// itself. The whole team shares ONE Tailscale-reachable VPS, so the URL is a
// build-time constant rather than per-machine configuration: every install
// (desktop app and browser) points at the same host with nothing to type, and a
// rebuild always yields it. The value is baked in from the `VITE_WORKSPACE_URL`
// build env var (set it to your tailnet IP / MagicDNS name before `vite build`);
// when unset it is empty and the Team tab simply shows nothing configured. There
// is deliberately no Settings field and no persisted value — an earlier per-user
// setting proved both unreliable across rebuilds and pointless for a single VPS.

/**
 * The VPS team-workspace base, baked in from `VITE_WORKSPACE_URL` at build time
 * (empty when unset). Reachable over Tailscale only (the tailnet IS the access
 * control — see the POC exposure precondition in CLAUDE.md).
 */
const configuredWorkspaceUrl: unknown = import.meta.env.VITE_WORKSPACE_URL
export const WORKSPACE_URL =
  typeof configuredWorkspaceUrl === 'string' ? configuredWorkspaceUrl : ''

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
