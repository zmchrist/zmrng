import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styles from './App.module.css'
import { api } from './api'
import { useWs } from './useWs'
import type {
  ServerConfig,
  Task,
  TaskEvent,
  WsEvent,
  ModelAlias,
  EffortLevel,
  CaveStyle,
  FlowMode,
  RepoTarget,
  WorkspaceMode,
  WorkspaceSettings,
  Attachment,
  SecurityScan,
} from './types'
import { WorkspaceView } from './components/WorkspaceView'
import { AuthBanner } from './components/AuthBanner'
import { TeamView } from './components/TeamView'
import { ActivityRail } from './components/ActivityRail'
import { KbView } from './components/KbView'
import { UpdateBanner } from './components/UpdateBanner'
import { SettingsModal } from './components/SettingsModal'
import { updateAvailable } from './updateGate'
import { modelEffortLabel } from './taskLabels'
import { useUiState } from './uiState'
import { nextRailState } from './railState'
import { hydrateChatTabs, hydrateTerminalTabs, type ChatTabState, type TabsState, type TerminalTabState } from './windowTabs'
import type { HandoffPrefill } from './teamHandoff'
import { isTauriRuntime } from './runtime'
import { workspaceHttpOrigin } from './teamConfig'
import { emptyUnread, hasUnread, markRead, observeTips, type ChannelTip } from './teamUnread'

// Read once — the runtime never changes mid-session.
const isNativeApp = isTauriRuntime()

// Idle-memory caps. A long-open task streaming for hours would otherwise grow
// the worker-log event array (and its DOM) and the single-turn `live` string
// without bound — the core idle leak. Trim both to a generous ceiling; older
// events are still on the server (re-fetched on reselect) and the trimmed head
// of a live turn is transient token noise finalized into an `event` anyway.
const MAX_EVENTS = 2000
const MAX_LIVE_CHARS = 200_000

// How often to re-check the team workspace for new messages while the operator
// is off the Team tab. Deliberately lazy — this is an ambient "something
// happened" hint, not a live feed.
const UNREAD_POLL_MS = 30_000

export default function App() {
  const [tasks, setTasks] = useState<Record<string, Task>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [securityScans, setSecurityScans] = useState<SecurityScan[]>([])
  const [live, setLive] = useState('')
  const [cfg, setCfg] = useState<ServerConfig | null>(null)
  const [repos, setRepos] = useState<RepoTarget[]>([])
  // Durable server-side Team prefs (workspace URL + display-name handle),
  // persisted in zmrng.db so they survive a refresh/app-reopen/rebuild/reboot —
  // browser localStorage proved unreliable for these in the desktop shell.
  const [settings, setSettings] = useState<WorkspaceSettings>({ workspaceUrl: '', teamHandle: '' })
  const ui = useUiState()
  // Workspace is the default home; migrate the retired `'tasks'`/`'board'` modes to it.
  const storedMode = ui.state.global.mode ?? 'workspace'
  const mode: WorkspaceMode =
    storedMode === 'tasks' || storedMode === 'board' ? 'workspace' : storedMode
  const setMode = useCallback((m: WorkspaceMode) => ui.patchGlobal({ mode: m }), [ui])
  // Optimistically update settings state, persist to the server, then reconcile
  // with the server's echoed full document (blank values normalize identically).
  const saveSettings = useCallback((patch: Partial<WorkspaceSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
    api.putSettings(patch).then(setSettings).catch(() => undefined)
  }, [])
  // The effective Team workspace URL: the persisted per-user value wins over the
  // ZMRNG_WORKSPACE_URL env default surfaced via ServerConfig.
  const effectiveWorkspaceUrl = settings.workspaceUrl || cfg?.workspaceUrl || ''
  // ---- Team unread orb (in-memory only, resets on relaunch) --------------
  // The workspace socket is gated on the Team tab being active (#149), so while
  // the operator is elsewhere there is no live feed to listen to. Instead poll a
  // cheap newest-message tip per channel over REST and fold it through the pure
  // `teamUnread` reducer; the rail orb lights when any channel has a message the
  // operator has not read. Nothing is persisted — no server, DB or type change.
  const [unread, setUnread] = useState(emptyUnread)
  const onChannelRead = useCallback((channelId: number, messageId: number) => {
    setUnread((prev) => markRead(prev, channelId, messageId))
  }, [])
  useEffect(() => {
    const origin = workspaceHttpOrigin(effectiveWorkspaceUrl)
    // Only poll while OFF the Team tab: on it, TeamView owns the live socket and
    // the orb is hidden anyway.
    if (mode === 'team' || !origin || !settings.teamHandle) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const channels = await api.listChannels(origin)
        const tips = await Promise.all(
          channels.map(async (c): Promise<ChannelTip | null> => {
            const [newest] = await api.getChannelMessages(c.id, { limit: 1 }, origin)
            return newest
              ? { channelId: c.id, messageId: newest.id, author: newest.author }
              : null
          }),
        )
        if (cancelled) return
        const seen = tips.filter((t): t is ChannelTip => t !== null)
        setUnread((prev) => observeTips(prev, seen, settings.teamHandle))
      } catch {
        // The VPS workspace is optional and may be unreachable — stay quiet and
        // retry on the next tick.
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), UNREAD_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [mode, effectiveWorkspaceUrl, settings.teamHandle])

  // Ephemeral: whether the Workspace Tasks side panel is collapsed. Re-clicking
  // the active Workspace rail button toggles it; leaving Workspace re-expands it.
  const [tasksCollapsed, setTasksCollapsed] = useState(false)
  // Activity-rail click: pure reducer decides mode + collapse from current state.
  const onRailClick = useCallback(
    (id: WorkspaceMode) => {
      const next = nextRailState({ mode, tasksCollapsed }, id)
      if (next.mode !== mode) setMode(next.mode)
      setTasksCollapsed(next.tasksCollapsed)
    },
    [mode, tasksCollapsed, setMode],
  )
  // Per-card tab-strip state for the Chat and Terminal panes, hydrated/persisted
  // from GlobalUiState — the live sessions themselves stay ephemeral. Feeds the
  // tabbed ChatCard/TerminalCard inside the Workspace IDE's Chat/Terminal tabs.
  // A unique seed id per app boot for the fresh default chat tab, so a newly
  // seeded "Chat 1" never reuses a closed tab's persisted transcript key.
  const chatSeedId = useMemo(() => `chat-${crypto.randomUUID()}`, [])
  const chatTabs = useMemo(
    () => hydrateChatTabs(ui.state.global.chatTabs, chatSeedId),
    [ui.state.global.chatTabs, chatSeedId],
  )
  const setChatTabs = useCallback((next: TabsState<ChatTabState>) => ui.patchGlobal({ chatTabs: next }), [ui])
  const terminalTabs = useMemo(
    () => hydrateTerminalTabs(ui.state.global.terminalTabs),
    [ui.state.global.terminalTabs],
  )
  const setTerminalTabs = useCallback(
    (next: TabsState<TerminalTabState>) => ui.patchGlobal({ terminalTabs: next }),
    [ui],
  )
  // Settings is an ephemeral modal overlay — never persisted.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // One-shot "Send to my zmrng" pre-fill from the Team tab (T3).
  const [handoffPrefill, setHandoffPrefill] = useState<HandoffPrefill | null>(null)
  // One-shot "Send to KB" navigation target from the Team tab (T4, #154): the
  // space + page to open in the KB tab after a message is promoted. A fresh
  // object per promotion lets KbView's one-shot seed fire once each time.
  const [kbTarget, setKbTarget] = useState<{ spaceId: number; pageId: number } | null>(null)
  // WS-B / D3: the newer origin/main sha the workspace socket advertised, once
  // it differs from this instance's headSha. Drives the global update banner.
  const [updateSha, setUpdateSha] = useState<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)

  // Coalesce streamed `partial` tokens into at most one `setLive` per animation
  // frame. A fast worker turn emits many tokens per frame; without this, each
  // token triggered its own full-app re-render, and over a long autonomous run
  // that render storm pegged the CPU/GPU (the core "bogs down after ~30 min"
  // symptom). Tokens buffer here and flush on the next rAF as a single update.
  const liveBufRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const flushLive = useCallback(() => {
    rafRef.current = null
    const chunk = liveBufRef.current
    if (!chunk) return
    liveBufRef.current = ''
    setLive((prev) => {
      const next = prev + chunk
      return next.length > MAX_LIVE_CHARS ? next.slice(next.length - MAX_LIVE_CHARS) : next
    })
  }, [])
  // Reset the pending live buffer + any queued flush — on task switch/removal a
  // stale flush must never append the old task's tail onto the new selection.
  const resetLiveBuffer = useCallback(() => {
    liveBufRef.current = ''
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const onWs = useCallback((e: WsEvent) => {
    switch (e.type) {
      case 'snapshot': {
        const map: Record<string, Task> = {}
        for (const t of e.tasks) map[t.id] = t
        setTasks(map)
        break
      }
      case 'task':
        setTasks((prev) => ({ ...prev, [e.task.id]: e.task }))
        break
      case 'event':
        if (e.taskId !== selectedIdRef.current) return
        setEvents((prev) => {
          const next = [...prev, e.event]
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
        })
        if (e.event.kind === 'claude' && e.event.payload.sub === 'assistant') {
          resetLiveBuffer()
          setLive('')
        }
        // A security-scan round just landed — refresh the Security panel live.
        if (e.event.kind === 'security') {
          api.listSecurityScans(e.taskId).then(setSecurityScans).catch(() => undefined)
        }
        break
      case 'partial':
        if (e.taskId !== selectedIdRef.current) return
        liveBufRef.current += e.text
        if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushLive)
        break
      case 'task-removed':
        setTasks((prev) => {
          const next = { ...prev }
          delete next[e.taskId]
          return next
        })
        if (e.taskId === selectedIdRef.current) {
          selectedIdRef.current = null
          setSelectedId(null)
          resetLiveBuffer()
          setLive('')
          setEvents([])
          setSecurityScans([])
        }
        break
    }
  }, [flushLive, resetLiveBuffer])

  const { connected } = useWs(onWs)

  useEffect(() => {
    api.getConfig().then(setCfg).catch(() => undefined)
    api.getSettings().then(setSettings).catch(() => undefined)
    api.listRepos().then(setRepos).catch(() => undefined)
    api
      .listTasks()
      .then((list) => {
        const map: Record<string, Task> = {}
        for (const t of list) map[t.id] = t
        setTasks(map)
      })
      .catch(() => undefined)
  }, [])

  const select = useCallback(async (id: string) => {
    selectedIdRef.current = id
    setSelectedId(id)
    resetLiveBuffer()
    setLive('')
    setEvents([])
    setSecurityScans([])
    try {
      setEvents(await api.getEvents(id))
    } catch {
      // events load failed — leave empty
    }
    // Security scan rows are read-only + independent; a failure just leaves the panel empty.
    api.listSecurityScans(id).then(setSecurityScans).catch(() => undefined)
  }, [resetLiveBuffer])

  // Cancel any pending live-flush frame on unmount.
  useEffect(() => resetLiveBuffer, [resetLiveBuffer])

  const onCreate = useCallback(
    async (
      title: string,
      body: string,
      opts: {
        model: ModelAlias
        effort: EffortLevel
        style: CaveStyle
        flow: FlowMode
        repoId: string
      },
      attachments?: Attachment[],
    ) => {
      const task = await api.createTask(title, body, opts, attachments)
      setTasks((prev) => ({ ...prev, [task.id]: task }))
      void select(task.id)
    },
    [select],
  )

  const sorted = useMemo(
    () =>
      Object.values(tasks).sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      ),
    [tasks],
  )

  // Team tab handoff: switch to Workspace and seed the local new-task box.
  const onSendToZmrng = useCallback(
    (prefill: HandoffPrefill) => {
      setMode('workspace')
      setHandoffPrefill({ ...prefill })
    },
    [setMode],
  )
  const onPrefillConsumed = useCallback(() => setHandoffPrefill(null), [])
  // Stable handle-change callback: passing a fresh arrow each render would
  // defeat the React.memo on TeamView/KbView, re-rendering those hidden
  // subtrees on every live token.
  const onTeamHandleChange = useCallback((h: string) => saveSettings({ teamHandle: h }), [saveSettings])

  // Team tab "Send to KB": switch to the KB tab and open the promoted page.
  const onOpenKbPage = useCallback(
    (spaceId: number, pageId: number) => {
      setMode('kb')
      setKbTarget({ spaceId, pageId })
    },
    [setMode],
  )

  // A `new-version` frame from the workspace socket (relayed by TeamView). Store
  // the advertised sha unconditionally; whether it is genuinely ahead of ours is
  // decided at render by the pure `updateAvailable` gate. Deferring the compare
  // to render (rather than gating here) closes a race where a frame arrives on
  // the on-connect seed before `cfg` (async `getConfig`) has resolved — the
  // banner then appears the moment `cfg.headSha` loads, instead of being dropped.
  const onNewVersion = useCallback((sha: string) => setUpdateSha(sha), [])

  const selected = selectedId ? tasks[selectedId] : undefined

  // ---- persistent title-bar breadcrumb + status-bar metrics ----
  const breadcrumb =
    mode === 'workspace'
      ? (selected?.title ?? 'No task selected')
      : mode === 'kb'
        ? 'KB'
        : 'Team'
  const lanes = cfg?.maxLanes ?? 0
  const running = sorted.filter((t) => t.status === 'executing').length
  const queued = sorted.filter((t) => t.queued).length
  const branch = selected?.branch ?? 'main'
  const modelLabel = modelEffortLabel(selected)

  return (
    <div className={styles.app} data-native={isNativeApp || undefined}>
      <AuthBanner />
      {updateAvailable(cfg?.headSha, updateSha ?? undefined) && (
        <UpdateBanner
          tasks={tasks}
          connected={connected}
          onDismiss={() => setUpdateSha(null)}
        />
      )}

      <div className={styles.frame}>
        {/* title bar (persistent) */}
        <div className={styles.tbar} data-tauri-drag-region>
          <span className={styles.tbBrand}>zmrng</span>
          <span className={styles.tbSep}>›</span>
          <span className={styles.tbCrumb}>{breadcrumb}</span>
          <span className={`${styles.tbConn} ${connected ? '' : styles.tbConnDown}`}>
            <span className={styles.tbConnDot} />
            {connected ? 'connected' : 'offline'}
          </span>
        </div>

        {/* body: persistent activity rail | swappable mode content */}
        <div className={styles.frameBody}>
          <ActivityRail
            mode={mode}
            teamUnread={mode !== 'team' && hasUnread(unread)}
            onSelect={onRailClick}
            onSettings={() => setSettingsOpen((v) => !v)}
          />

          <div
            className={styles.modeContent}
            style={{ display: mode === 'workspace' ? 'flex' : 'none' }}
          >
            <WorkspaceView
              task={selected}
              events={events}
              securityScans={securityScans}
              live={live}
              tasks={sorted}
              repos={repos}
              config={cfg}
              selectedId={selectedId}
              tasksCollapsed={tasksCollapsed}
              chatTabs={chatTabs}
              onChatTabsChange={setChatTabs}
              terminalTabs={terminalTabs}
              onTerminalTabsChange={setTerminalTabs}
              onSelect={select}
              onCreate={onCreate}
              prefill={handoffPrefill}
              onPrefillConsumed={onPrefillConsumed}
              onStart={() => (selected ? api.start(selected.id) : Promise.resolve())}
              onMessage={(text, attachments) =>
                selected ? api.message(selected.id, text, attachments) : Promise.resolve()
              }
              onResume={() => (selected ? api.resume(selected.id) : Promise.resolve())}
              onRestart={() => (selected ? api.restartAgent(selected.id) : Promise.resolve())}
              onInterrupt={() => (selected ? api.interrupt(selected.id) : Promise.resolve())}
              onDone={() => (selected ? api.done(selected.id) : Promise.resolve())}
              onCancel={() => (selected ? api.cancel(selected.id) : Promise.resolve())}
              onDelete={() => (selected ? api.deleteTask(selected.id) : Promise.resolve())}
            />
          </div>

          <div
            className={styles.modeContent}
            style={{ display: mode === 'team' ? 'flex' : 'none' }}
          >
            <TeamView
              workspaceUrl={effectiveWorkspaceUrl}
              teamHandle={settings.teamHandle}
              botHandle={cfg?.botHandle ?? '@agent'}
              repos={repos}
              onHandleChange={onTeamHandleChange}
              onSendToZmrng={onSendToZmrng}
              onOpenKbPage={onOpenKbPage}
              onNewVersion={onNewVersion}
              onChannelRead={onChannelRead}
              active={mode === 'team'}
            />
          </div>

          <div
            className={styles.modeContent}
            style={{ display: mode === 'kb' ? 'flex' : 'none' }}
          >
            <KbView
              teamHandle={settings.teamHandle}
              onHandleChange={onTeamHandleChange}
              openTarget={kbTarget}
              active={mode === 'kb'}
            />
          </div>
        </div>

        {/* status bar (persistent) */}
        <div className={styles.sbar}>
          <span className={styles.sbBranch}>{branch}</span>
          <span className={styles.sbItem}>
            · {running}/{lanes} lanes{queued > 0 ? ` · ${queued} queued` : ''}
          </span>
          <span className={styles.sbSpacer} />
          <span className={styles.sbItem}>{modelLabel}</span>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        connected={connected}
        workspaceUrl={settings.workspaceUrl}
        onWorkspaceUrlChange={(url) => saveSettings({ workspaceUrl: url })}
      />
    </div>
  )
}
