import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UiState } from './types.js'

const STATE_DIR = path.join(os.homedir(), '.zmrng')
const STATE_PATH = path.join(STATE_DIR, 'ui-state.json')

function emptyState(): UiState {
  return { global: {}, perTask: {} }
}

/** Read `~/.zmrng/ui-state.json`. Never throws — missing file or a parse
 *  error both fall back to an empty document. */
export function readUiState(): UiState {
  try {
    if (!existsSync(STATE_PATH)) return emptyState()
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<UiState>
    return {
      global: parsed.global ?? {},
      perTask: parsed.perTask ?? {},
    }
  } catch {
    return emptyState()
  }
}

/** Best-effort whole-document write. Never throws — a write failure is
 *  silently dropped rather than blocking the caller. */
export function writeUiState(state: UiState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // best-effort persistence — swallow
  }
}

/** Drop a task's per-task entry (called when its worktree is removed) so the
 *  settings file stays bounded. Best-effort — never throws. */
export function pruneTask(taskId: string): void {
  try {
    const state = readUiState()
    if (!(taskId in state.perTask)) return
    delete state.perTask[taskId]
    writeUiState(state)
  } catch {
    // best-effort — swallow
  }
}
