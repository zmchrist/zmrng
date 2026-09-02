// Pure localStorage persistence for the standalone chat tabs (mirrors
// `themes.ts`'s storage pattern). Only the chat feature persists across a
// refresh/rebuild/tab-reopen — terminal tabs and PTY sessions stay ephemeral.
// Two things round-trip: which chat tabs were open (order + last-focused id)
// and each tab's message transcript, so a reload can auto-reopen every prior
// chat tab with its scrollable history intact even though the underlying
// `claude` process is gone and will respawn fresh on the next message.

import type { ThreadItem } from './chatThread'
import { MAX_THREAD_ITEMS } from './chatThread'

const STORAGE_KEY = 'zmrng-chat-sessions'

interface StoredSessions {
  /** Open chat tab ids, in tab-strip order. */
  order: string[]
  /** Last-focused chat tab id, if any. */
  activeId: string | null
  /** Each tab's saved transcript, keyed by tab id. */
  threads: Record<string, ThreadItem[]>
}

function emptySessions(): StoredSessions {
  return { order: [], activeId: null, threads: {} }
}

function loadSessions(): StoredSessions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptySessions()
    const parsed = JSON.parse(raw) as Partial<StoredSessions>
    return {
      order: Array.isArray(parsed.order) ? parsed.order.filter((id) => typeof id === 'string') : [],
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      threads: parsed.threads && typeof parsed.threads === 'object' ? parsed.threads : {},
    }
  } catch {
    return emptySessions()
  }
}

function saveSessions(sessions: StoredSessions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
  } catch {
    // localStorage unavailable (private mode, quota) — chat just won't persist.
  }
}

/** The persisted tab order + last-focused id (chat tabs only). */
export function loadChatOrder(): { order: string[]; activeId: string | null } {
  const { order, activeId } = loadSessions()
  return { order, activeId }
}

/** Persist the current chat tab order + focused id (called on every dock change). */
export function saveChatOrder(order: string[], activeId: string | null): void {
  const sessions = loadSessions()
  saveSessions({ ...sessions, order, activeId })
}

/** The saved transcript for one chat tab, or `[]` if none is stored. */
export function loadChatThread(id: string): ThreadItem[] {
  return loadSessions().threads[id] ?? []
}

/**
 * Persist one chat tab's transcript, capped to the newest `MAX_THREAD_ITEMS`.
 * Without the cap the on-disk transcript grows without bound and is read back
 * into memory in full on every reload — a persistent idle memory leak.
 */
export function saveChatThread(id: string, items: ThreadItem[]): void {
  const sessions = loadSessions()
  const capped = items.length > MAX_THREAD_ITEMS ? items.slice(items.length - MAX_THREAD_ITEMS) : items
  saveSessions({ ...sessions, threads: { ...sessions.threads, [id]: capped } })
}

/** Drop one chat tab's saved transcript (called when its tab is closed). */
export function removeChatThread(id: string): void {
  const sessions = loadSessions()
  if (!(id in sessions.threads)) return
  const threads = { ...sessions.threads }
  delete threads[id]
  saveSessions({ ...sessions, threads })
}

/**
 * Render a saved transcript as plain text context for priming a freshly
 * respawned `claude` session (the old session died with the page; this is
 * how the new one "understands what we were talking about"). Only user/agent
 * bubbles are included — tool notes are UI-only chrome, not part of the
 * conversation content.
 */
export function serializeTranscript(items: ThreadItem[]): string {
  const lines = items
    .filter((i): i is Extract<ThreadItem, { kind: 'user' | 'agent' }> => i.kind === 'user' || i.kind === 'agent')
    .map((i) => `${i.kind === 'user' ? 'User' : 'Assistant'}: ${i.text}`)
  if (lines.length === 0) return ''
  return `[Resuming a previous conversation. Prior transcript for context:]\n${lines.join('\n')}\n[End of prior transcript]`
}
