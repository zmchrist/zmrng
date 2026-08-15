import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PreflightResult, PreflightSignal } from './types.js'

/** Short timeout so a hung `gh`/credential probe never stalls the endpoint. */
const PROBE_TIMEOUT_MS = 1500

/**
 * Best-effort presence heuristic for a Max OAuth login: never spawns `claude`
 * itself, just checks for the credentials file it writes on login, or a
 * standing `ANTHROPIC_API_KEY` (the apikey-mode escape hatch).
 */
function checkClaudeAuth(): PreflightSignal {
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json')
  if (existsSync(credsPath)) {
    return { ok: true, detail: 'Max OAuth credentials found' }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { ok: true, detail: 'ANTHROPIC_API_KEY set' }
  }
  return { ok: false, detail: 'no Max OAuth credentials or ANTHROPIC_API_KEY found' }
}

/**
 * Best-effort presence heuristic for `gh` auth, distinct from claude auth.
 * Prefers the fast, non-network `gh auth status` exit code; falls back to the
 * hosts file so a missing/broken `gh` binary still degrades gracefully.
 */
function checkGhAuth(): PreflightSignal {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS })
    return { ok: true, detail: 'gh auth status OK' }
  } catch {
    const hostsPath = path.join(os.homedir(), '.config', 'gh', 'hosts.yml')
    if (existsSync(hostsPath)) {
      return { ok: true, detail: 'gh hosts.yml found (auth status check failed)' }
    }
    return { ok: false, detail: 'gh not authenticated (run `gh auth login`)' }
  }
}

/**
 * Best-effort presence check for a binary on PATH, distinct from the
 * claude/gh auth signals above — this only asks "is it installed at all".
 */
function checkOnPath(bin: string): PreflightSignal {
  try {
    execFileSync('which', [bin], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS })
    return { ok: true, detail: `${bin} found on PATH` }
  } catch {
    return { ok: false, detail: `${bin} not found on PATH` }
  }
}

/** Fresh probe on every call — never cached, so a poller sees state changes live. */
export function runPreflight(): PreflightResult {
  return {
    claude: safe(checkClaudeAuth),
    gh: safe(checkGhAuth),
    path: {
      git: safe(() => checkOnPath('git')),
      gh: safe(() => checkOnPath('gh')),
      claude: safe(() => checkOnPath('claude')),
    },
  }
}

/** Never throws — a broken probe reports as a failed signal, not a 500. */
function safe(fn: () => PreflightSignal): PreflightSignal {
  try {
    return fn()
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'probe failed' }
  }
}
