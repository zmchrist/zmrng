import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './TeamView.module.css'
import type { Channel, Message, RepoTarget, WorkspaceMember } from '../types'
import { MAX_DISPLAY_NAME_LEN, MAX_MESSAGE_BODY_LEN } from '../types'
import {
  mentionCandidates,
  activeMention,
  filterCandidates,
  applyMention,
  parseMentions,
  type MentionCandidate,
} from '../mentions'
import {
  encodeHello,
  encodePing,
  encodeSubscribe,
  encodeUnsubscribe,
  encodeMessage,
  parseWorkspaceServerMsg,
} from '../workspaceProtocol'
import { emptyRoster, applyWorkspaceMsg } from '../roster'
import { emptyThread, appendMessage, loadScrollback } from '../channelThread'
import { useAutoScroll } from '../useAutoScroll'
import { api } from '../api'
import { buildHandoffPrefill, type HandoffPrefill } from '../teamHandoff'
import {
  loadStoredHandle,
  saveStoredHandle,
  resolveWorkspaceUrl,
  workspaceSocketUrl,
  workspaceHttpOrigin,
} from '../teamConfig'

interface Props {
  /** Optional server-side default VPS URL (ServerConfig.workspaceUrl). The
   *  per-teammate localStorage value wins over this when set. */
  workspaceUrl: string
  /** The shared team-agent bot handle (default `@agent`), surfaced via
   *  GET /api/config so the `@`-mention autocomplete + highlighter know the
   *  agent's name. Visual only — the server reply trigger is unchanged. */
  botHandle: string
  /** The teammate's OWN local repo registry (GET /api/repos), used to populate
   *  the create-channel repo select — a channel repo id is a free-text tag. */
  repos: RepoTarget[]
  /** Lift a "Send to my zmrng" handoff up to App: switch to Workspace and seed
   *  the local new-task box with this brief (T3, decision D6). */
  onSendToZmrng: (prefill: HandoffPrefill) => void
  /** Bubble a `new-version` frame's sha up to App (WS-B / D3). TeamView owns the
   *  socket but NOT the update banner — the phase-gate needs App's `tasks`. */
  onNewVersion?: (sha: string) => void
}

const PING_MS = 25000
const RECONNECT_MS = 2000
const SCROLLBACK_LIMIT = 50

/** Render a channel's name with the conventional leading `#`. */
function channelLabel(name: string): string {
  return `#${name}`
}

/**
 * The Team mode surface: connects to the configured VPS team-workspace server
 * over ONE multiplexed WebSocket, self-asserts a free-text display-name handle,
 * lists channels, opens one, renders its messages (scrollback via REST + live
 * NEW messages via the socket), and posts to it via a composer. Human and agent
 * messages render distinguishably (box 6). Local task execution is untouched.
 *
 * This is connection glue (like WorkspaceGrid) — the wire protocol, roster +
 * channel-thread reducers, and config resolution it composes are each
 * unit-tested in isolation.
 */
export function TeamView({ workspaceUrl, botHandle, repos, onSendToZmrng, onNewVersion }: Props) {
  const resolvedUrl = resolveWorkspaceUrl(workspaceUrl)
  const socketUrl = workspaceSocketUrl(resolvedUrl)
  // The VPS http origin for channel REST (list/create/scrollback). Channel data
  // lives on the VPS, not the teammate's local server, so these calls MUST be
  // origin-prefixed — otherwise a channel is created in the local SQLite and no
  // teammate ever sees it.
  const httpOrigin = workspaceHttpOrigin(resolvedUrl)
  const [handle, setHandle] = useState<string>(() => loadStoredHandle())
  const [draft, setDraft] = useState('')
  const [roster, setRoster] = useState<WorkspaceMember[]>(emptyRoster)
  const [connected, setConnected] = useState(false)
  const [channels, setChannels] = useState<Channel[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [thread, setThread] = useState<Message[]>(emptyThread)
  const [composer, setComposer] = useState('')
  // `@`-mention autocomplete state for the channel composer. `mentionStart` is
  // the index of the active `@`; `mentionMatches` is the live-filtered candidate
  // list (empty ⇒ dropdown closed); `mentionIndex` is the highlighted row.
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionMatches, setMentionMatches] = useState<MentionCandidate[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const composerRef = useRef<HTMLInputElement | null>(null)
  // Create-channel affordance state (T3). The list itself refreshes via the
  // server's `channels` broadcast over the shared socket.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRepo, setNewRepo] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // Latest open-channel id, readable inside the stable socket onmessage closure.
  const openIdRef = useRef<number | null>(null)
  useEffect(() => {
    openIdRef.current = openId
  }, [openId])
  // Keep the latest `onNewVersion` readable inside the stable socket closure
  // (the socket effect only re-runs on handle/url change), mirroring openIdRef.
  const onNewVersionRef = useRef(onNewVersion)
  useEffect(() => {
    onNewVersionRef.current = onNewVersion
  }, [onNewVersion])
  // Thread auto-scroll: jumps to the bottom on new content only if the user
  // was already at/near the bottom (never yanks them away from scrollback);
  // `scrollToBottom` force-scrolls regardless, used for our own posts and on
  // channel switch.
  const {
    ref: threadRef,
    onScroll: onThreadScroll,
    scrollToBottom,
    notifyContentChanged: notifyThreadChanged,
  } = useAutoScroll<HTMLUListElement>()
  useEffect(() => {
    notifyThreadChanged()
  }, [thread, notifyThreadChanged])

  /** Send a pre-encoded frame if the socket is live (dropped otherwise). */
  const sendFrame = (data: string): void => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(data)
  }

  // ---- socket lifecycle (presence + live message delivery) ----
  useEffect(() => {
    if (!handle || !socketUrl) return
    let closed = false
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined

    const connect = (): void => {
      try {
        ws = new WebSocket(socketUrl)
      } catch {
        reconnect = setTimeout(connect, RECONNECT_MS)
        return
      }
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        ws?.send(encodeHello(handle))
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(encodePing())
        }, PING_MS)
      }
      ws.onmessage = (ev) => {
        const msg = parseWorkspaceServerMsg(String(ev.data))
        if (!msg) return
        if (msg.type === 'message') {
          // Only the currently-open channel's live messages hit the thread.
          if (msg.message.channelId === openIdRef.current) {
            setThread((prev) => appendMessage(prev, msg.message))
          }
        } else if (msg.type === 'channels') {
          setChannels(msg.channels)
        } else if (msg.type === 'new-version') {
          // Bubble UP to App — it owns `tasks` (for the D3a phase-gate) and the
          // global update banner. TeamView just relays the signal.
          onNewVersionRef.current?.(msg.sha)
        } else {
          setRoster((prev) => applyWorkspaceMsg(prev, msg))
        }
      }
      ws.onclose = () => {
        setConnected(false)
        if (ping) clearInterval(ping)
        if (!closed) reconnect = setTimeout(connect, RECONNECT_MS)
      }
      ws.onerror = () => ws?.close()
    }
    connect()

    return () => {
      closed = true
      if (ping) clearInterval(ping)
      if (reconnect) clearTimeout(reconnect)
      ws?.close()
      wsRef.current = null
      setConnected(false)
      setRoster(emptyRoster())
    }
  }, [handle, socketUrl])

  // ---- load the channel list once connected; default to the first channel ----
  useEffect(() => {
    if (!handle || !connected) return
    let cancelled = false
    api
      .listChannels(httpOrigin)
      .then((list) => {
        if (cancelled) return
        setChannels(list)
        setOpenId((cur) => (cur !== null ? cur : (list[0]?.id ?? null)))
      })
      .catch(() => {
        // transient failure — the socket stays live; a reconnect retries this
      })
    return () => {
      cancelled = true
    }
  }, [handle, connected, httpOrigin])

  // ---- open a channel: REST scrollback + subscribe to live fan-out ----
  // The thread is reset in the channel-switch handlers (not here) to keep this
  // effect free of synchronous setState; on a plain reconnect the scrollback
  // page merges (deduped) into whatever live messages already arrived.
  useEffect(() => {
    if (!connected || openId === null) return
    let cancelled = false
    api
      .getChannelMessages(openId, { limit: SCROLLBACK_LIMIT }, httpOrigin)
      .then((page) => {
        if (!cancelled) setThread((prev) => loadScrollback(prev, page))
      })
      .catch(() => {
        // scrollback failed — live messages still flow once subscribed
      })
    sendFrame(encodeSubscribe(openId))
    return () => {
      cancelled = true
      sendFrame(encodeUnsubscribe(openId))
    }
  }, [connected, openId, httpOrigin])

  /** Switch the open channel, clearing the previous channel's thread. */
  const openChannelId = (id: number): void => {
    if (id === openId) return
    scrollToBottom()
    setThread(emptyThread())
    setOpenId(id)
  }

  const onJoin = (e: React.FormEvent) => {
    e.preventDefault()
    const name = draft.trim()
    if (!name) return
    saveStoredHandle(name)
    setHandle(name)
  }

  const onLeave = () => {
    saveStoredHandle('')
    setHandle('')
    setDraft('')
    setOpenId(null)
    setThread(emptyThread())
  }

  // ---- `@`-mention autocomplete (visual only; the agent trigger is server-side) ----
  // Candidates = roster displayNames + the agent (bot handle minus a leading @);
  // `mentionNames` drives the in-thread pill highlighter.
  const candidates = useMemo(() => mentionCandidates(roster, botHandle), [roster, botHandle])
  const mentionNames = useMemo(() => candidates.map((c) => c.name), [candidates])

  /** Recompute the dropdown from the composer's current value + caret. */
  const refreshMention = (value: string, caret: number): void => {
    const active = activeMention(value, caret)
    if (!active) {
      setMentionStart(null)
      setMentionMatches([])
      return
    }
    const matches = filterCandidates(candidates, active.query)
    setMentionStart(matches.length ? active.start : null)
    setMentionMatches(matches)
    setMentionIndex(0)
  }

  const closeMention = (): void => {
    setMentionStart(null)
    setMentionMatches([])
  }

  const onComposerChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const el = e.currentTarget
    setComposer(el.value)
    refreshMention(el.value, el.selectionStart ?? el.value.length)
  }

  /** Track caret moves (click, arrow keys while closed) so `@` context stays fresh. */
  const onComposerSelect = (e: React.SyntheticEvent<HTMLInputElement>): void => {
    const el = e.currentTarget
    refreshMention(el.value, el.selectionStart ?? el.value.length)
  }

  /** Insert the chosen candidate, replacing the active `@query`, and restore caret. */
  const chooseMention = (cand: MentionCandidate): void => {
    if (mentionStart === null) return
    const el = composerRef.current
    const caret = el?.selectionStart ?? composer.length
    const { text, caret: nextCaret } = applyMention(composer, mentionStart, caret, cand.name)
    setComposer(text)
    closeMention()
    requestAnimationFrame(() => {
      const node = composerRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (mentionMatches.length === 0) return // closed → let Enter submit as usual
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionMatches.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
        break
      case 'Enter':
      case 'Tab':
        e.preventDefault()
        chooseMention(mentionMatches[mentionIndex] ?? mentionMatches[0])
        break
      case 'Escape':
        e.preventDefault()
        closeMention()
        break
    }
  }

  const onSend = (e: React.FormEvent) => {
    e.preventDefault()
    const body = composer.trim()
    if (!body || openId === null) return
    // Posted human message returns via the channel fan-out (we are subscribed),
    // so it appears in the thread through the live socket — no optimistic append.
    scrollToBottom()
    sendFrame(encodeMessage(openId, handle, body))
    setComposer('')
    closeMention()
  }

  // Create a channel over REST (T3). The server broadcasts the refreshed list to
  // the workspace room, so every connected teammate's rail (including this one)
  // updates via the `channels` socket frame — no manual setChannels needed here.
  const onCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name || createBusy) return
    setCreateBusy(true)
    setCreateError(null)
    try {
      const created = await api.createChannel(name, newRepo || null, httpOrigin)
      setNewName('')
      setNewRepo('')
      setCreating(false)
      // Open the freshly created channel (the broadcast populates the rail).
      setChannels((prev) =>
        prev.some((c) => c.id === created.id) ? prev : [...prev, created],
      )
      openChannelId(created.id)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create channel')
    } finally {
      setCreateBusy(false)
    }
  }

  /** Hand a channel message off to the local zmrng new-task box (T3). */
  const sendMessageToZmrng = (channel: Channel, message: Message): void => {
    onSendToZmrng(buildHandoffPrefill(channel, message))
  }

  if (!socketUrl) {
    return (
      <div className={styles.team}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No team workspace configured</p>
          <p className={styles.emptyHint}>
            Set the VPS team-workspace URL in <strong>Settings</strong> to connect.
          </p>
        </div>
      </div>
    )
  }

  if (!handle) {
    return (
      <div className={styles.team}>
        <form className={styles.join} onSubmit={onJoin}>
          <label className={styles.joinLabel} htmlFor="team-handle">
            Pick a display name
          </label>
          <p className={styles.joinHint}>
            A free-text handle — no password. You&apos;ll appear in the team roster.
          </p>
          <div className={styles.joinRow}>
            <input
              id="team-handle"
              className={styles.input}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. Ada"
              maxLength={MAX_DISPLAY_NAME_LEN}
              autoFocus
            />
            <button type="submit" className={styles.joinBtn} disabled={!draft.trim()}>
              Join
            </button>
          </div>
        </form>
      </div>
    )
  }

  const onlineCount = roster.filter((m) => m.online).length
  const openChannel = channels.find((c) => c.id === openId) ?? null

  return (
    <div className={styles.team}>
      <div className={styles.teamHead}>
        <span className={styles.you}>
          <span
            className={`${styles.dot} ${connected ? styles.dotOn : styles.dotOff}`}
            aria-hidden="true"
          />
          {connected ? 'connected' : 'connecting…'} as <strong>{handle}</strong>
          <button type="button" className={styles.leaveBtn} onClick={onLeave} title="Change name">
            change name
          </button>
        </span>
      </div>

      <div className={styles.body}>
        <div className={styles.rail}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Channels</span>
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => {
                setCreating((v) => !v)
                setCreateError(null)
              }}
              title={creating ? 'Cancel' : 'New channel'}
            >
              {creating ? '×' : '+ new'}
            </button>
          </div>
          {creating && (
            <form className={styles.createForm} onSubmit={onCreateChannel}>
              <input
                className={styles.input}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="channel-name"
                maxLength={MAX_DISPLAY_NAME_LEN}
                autoFocus
              />
              <select
                className={styles.select}
                value={newRepo}
                onChange={(e) => setNewRepo(e.target.value)}
              >
                <option value="">No repo (like #general)</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              {createError && <span className={styles.createError}>{createError}</span>}
              <button
                type="submit"
                className={styles.joinBtn}
                disabled={!newName.trim() || createBusy}
              >
                {createBusy ? 'Creating…' : 'Create channel'}
              </button>
            </form>
          )}
          <ul className={styles.channels}>
            {channels.length === 0 && <li className={styles.railEmpty}>No channels yet.</li>}
            {channels.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`${styles.channel} ${c.id === openId ? styles.channelActive : ''}`}
                  onClick={() => openChannelId(c.id)}
                >
                  {channelLabel(c.name)}
                  {c.repoId && <span className={styles.channelRepoDot} title={c.repoId} />}
                </button>
              </li>
            ))}
          </ul>

          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Roster</span>
            <span className={styles.rosterCount}>
              {onlineCount} online · {roster.length} total
            </span>
          </div>
          <ul className={styles.roster}>
            {roster.length === 0 && <li className={styles.railEmpty}>No members yet.</li>}
            {roster.map((m) => (
              <li key={m.id} className={styles.member}>
                <span
                  className={`${styles.dot} ${m.online ? styles.dotOn : styles.dotOff}`}
                  aria-hidden="true"
                />
                <span className={styles.memberName}>{m.displayName}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className={styles.channelPane}>
          {openChannel ? (
            <>
              <div className={styles.channelHead}>
                <span className={styles.channelName}>{channelLabel(openChannel.name)}</span>
                {openChannel.repoId && (
                  <span className={styles.channelRepo}>{openChannel.repoId}</span>
                )}
              </div>
              <ul className={styles.thread} ref={threadRef} onScroll={onThreadScroll}>

                {thread.length === 0 && <li className={styles.threadEmpty}>No messages yet.</li>}
                {thread.map((m) => (
                  <li
                    key={m.id}
                    className={`${styles.message} ${
                      m.kind === 'agent' ? styles.messageAgent : styles.messageHuman
                    }`}
                  >
                    <span className={styles.messageAuthor}>
                      {m.author}
                      {m.kind === 'agent' && <span className={styles.agentTag}>agent</span>}
                      <button
                        type="button"
                        className={styles.sendZmrng}
                        onClick={() => sendMessageToZmrng(openChannel, m)}
                        title="Create a local zmrng task from this message"
                      >
                        Send to my zmrng
                      </button>
                    </span>
                    <span className={styles.messageBody}>
                      {parseMentions(m.body, mentionNames).map((seg, idx) =>
                        seg.type === 'mention' ? (
                          <span key={idx} className={styles.mention}>
                            {seg.text}
                          </span>
                        ) : (
                          <span key={idx}>{seg.text}</span>
                        ),
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <form className={styles.composer} onSubmit={onSend}>
                <div className={styles.composerWrap}>
                  {mentionMatches.length > 0 && (
                    <ul className={styles.mentionMenu}>
                      {mentionMatches.map((cand, idx) => (
                        <li key={`${cand.kind}:${cand.name}`}>
                          <button
                            type="button"
                            className={`${styles.mentionItem} ${
                              idx === mentionIndex ? styles.mentionItemActive : ''
                            }`}
                            // Keep composer focus (avoid the input's blur closing the menu first).
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => chooseMention(cand)}
                          >
                            <span>{cand.name}</span>
                            {cand.kind === 'agent' && (
                              <span className={styles.mentionTag}>agent</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <input
                    ref={composerRef}
                    className={styles.input}
                    type="text"
                    value={composer}
                    onChange={onComposerChange}
                    onKeyDown={onComposerKeyDown}
                    onSelect={onComposerSelect}
                    onBlur={closeMention}
                    placeholder={`Message ${channelLabel(openChannel.name)}`}
                    maxLength={MAX_MESSAGE_BODY_LEN}
                    disabled={!connected}
                  />
                </div>
                <button
                  type="submit"
                  className={styles.joinBtn}
                  disabled={!composer.trim() || !connected}
                >
                  Send
                </button>
              </form>
            </>
          ) : (
            <div className={styles.threadEmpty}>Select a channel to start chatting.</div>
          )}
        </div>
      </div>
    </div>
  )
}
