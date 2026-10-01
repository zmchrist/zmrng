import { useCallback, useId, useState, type FormEvent } from 'react'
import styles from './LoopView.module.css'
import { LOOP_MAX_LANES } from '../types'
import type { LoopCreateRequest, LoopEvent, LoopRun, LoopRunView, RepoTarget } from '../types'
import { loopApi, type LoopApi } from '../loopProtocol'
import { RUN_STATUS_LABEL, runStatusColor } from '../loopMap'
import { taskRepoLabel } from '../laneRows'
import { openExternal } from '../openExternal'
import { LoopChat } from './LoopChat'
import { LoopLanes } from './LoopLanes'
import { LoopMap } from './LoopMap'

/** The REST calls the open-run pane makes; injectable so tests need no fetch. */
export type LoopClient = Pick<
  LoopApi,
  'start' | 'pause' | 'resume' | 'archive' | 'setLanes' | 'chat' | 'stopTicket'
>

interface Props {
  /** Every run, non-archived first (the run picker). */
  runs: LoopRun[]
  /** The run open in the view; may be set before its view has loaded. */
  openRunId: string | null
  /** The open run's full view (null until fetched). */
  view: LoopRunView | null
  /** The open run's events (orchestrator transcript + lane activity). */
  events: LoopEvent[]
  /** The orchestrator's in-flight reply. */
  partial: string
  /** Why the open run's view failed to load (shown instead of "Loading run…"). */
  loadError?: string | null
  repos: RepoTarget[]
  /** True while the Loop mode is the visible one (gates the elapsed tick). */
  active: boolean
  /** Open a run, or `null` to return to the run picker. */
  onOpenRun: (id: string | null) => void
  /** Create a run; rejects with the server's error text. */
  onCreate: (req: LoopCreateRequest) => Promise<void>
  /** A fresh view returned by an action, applied before its `loop` frame lands. */
  onView?: (view: LoopRunView) => void
  client?: LoopClient
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A positive whole issue number, or null. */
function parseEpic(raw: string): number | null {
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** New run: repo + epic only. The lane count is the orchestrator's call. */
function NewRunForm({
  repos,
  onCreate,
}: {
  repos: RepoTarget[]
  onCreate: (req: LoopCreateRequest) => Promise<void>
}) {
  const repoFieldId = useId()
  const epicFieldId = useId()
  const [repoId, setRepoId] = useState('')
  const [epic, setEpic] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Derived, not synced in an effect: an untouched select means the first repo.
  const effectiveRepoId = repoId || repos[0]?.id || ''
  const epicNum = parseEpic(epic)
  const canCreate = effectiveRepoId !== '' && epicNum !== null && !busy

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canCreate || epicNum === null) return
    setBusy(true)
    setError(null)
    try {
      await onCreate({ repoId: effectiveRepoId, epic: epicNum })
      setEpic('')
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} aria-label="New loop run">
      <div className={styles.field}>
        <label htmlFor={repoFieldId}>Repo</label>
        <select
          id={repoFieldId}
          className={styles.control}
          value={effectiveRepoId}
          onChange={(e) => setRepoId(e.target.value)}
          disabled={repos.length === 0}
        >
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor={epicFieldId}>Epic issue #</label>
        <input
          id={epicFieldId}
          className={styles.control}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder="e.g. 214"
          value={epic}
          onChange={(e) => setEpic(e.target.value)}
        />
      </div>
      <button type="submit" className={styles.primaryBtn} disabled={!canCreate}>
        Create run
      </button>
      {repos.length === 0 && <p className={styles.hint}>No repos are registered.</p>}
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
    </form>
  )
}

/** No run open: create one, or pick an existing one. */
function RunPicker({
  runs,
  repos,
  onOpenRun,
  onCreate,
}: {
  runs: LoopRun[]
  repos: RepoTarget[]
  onOpenRun: (id: string) => void
  onCreate: (req: LoopCreateRequest) => Promise<void>
}) {
  return (
    <section className={styles.picker} aria-label="Loop runs">
      <div className={styles.pickerInner}>
        <h2 className={styles.pickerTitle}>Loop</h2>
        <p className={styles.hint}>
          Runs the gauntlet over an epic’s sub-issues: a fresh builder per round, a blind critic against
          each ticket’s bar, then validate, docs and a serial fold into one integration branch and a
          single PR.
        </p>
        <NewRunForm repos={repos} onCreate={onCreate} />
        <h3 className={styles.sectionTitle}>Runs</h3>
        {runs.length === 0 ? (
          <p className={styles.hint}>No runs yet.</p>
        ) : (
          <ul className={styles.runList}>
            {runs.map((r) => (
              <li key={r.id}>
                <button type="button" className={styles.runRow} onClick={() => onOpenRun(r.id)}>
                  <span className={styles.runRowTitle}>
                    #{r.epic} {r.title}
                  </span>
                  <span className={styles.pill} style={{ color: runStatusColor(r.status) }}>
                    {RUN_STATUS_LABEL[r.status]}
                  </span>
                  <span className={styles.dim}>{taskRepoLabel(r.repoId, repos)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** Archive with an inline confirm: it kills every runner and removes worktrees. */
function ArchiveButton({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <button
        type="button"
        className={styles.btn}
        aria-label="Archive run"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        Archive
      </button>
    )
  }
  return (
    <span className={styles.confirm} role="group" aria-label="Archive this run?">
      <span className={styles.dim}>Archive this run?</span>
      <button
        type="button"
        className={styles.btn}
        aria-label="Confirm archive"
        onClick={() => {
          setConfirming(false)
          onConfirm()
        }}
      >
        Yes
      </button>
      <button
        type="button"
        className={styles.btn}
        aria-label="Cancel archive"
        onClick={() => setConfirming(false)}
      >
        No
      </button>
    </span>
  )
}

/** One open run: slim header + the fixed chat | lanes/map grid. */
function RunPane({
  view,
  events,
  partial,
  repos,
  active,
  onOpenRun,
  onView,
  client,
}: {
  view: LoopRunView
  events: LoopEvent[]
  partial: string
  repos: RepoTarget[]
  active: boolean
  onOpenRun: (id: string | null) => void
  onView?: (view: LoopRunView) => void
  client: LoopClient
}) {
  const { run } = view
  const prUrl = run.prUrl
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const perform = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setPending(false)
    }
  }, [])

  const apply = (next: LoopRunView): void => onView?.(next)
  const canStart = run.status === 'draft' || run.status === 'paused'
  const settled = run.status === 'complete' || run.status === 'finalizing'

  return (
    <section className={styles.root} aria-label="Loop run">
      <header className={styles.header}>
        <button type="button" className={styles.btn} onClick={() => onOpenRun(null)}>
          All runs
        </button>
        <h2 className={styles.runTitle} title={run.title}>
          #{run.epic} {run.title}
        </h2>
        <span className={styles.pill} style={{ color: runStatusColor(run.status) }}>
          {RUN_STATUS_LABEL[run.status]}
        </span>
        <span className={styles.dim}>
          {taskRepoLabel(run.repoId, repos)} · {run.integBranch}
        </span>
        <span className={styles.spacer} />
        {canStart && (
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={pending}
            onClick={() => void perform(async () => apply(await client.start(run.id)))}
          >
            Start
          </button>
        )}
        {run.status === 'running' && (
          <button
            type="button"
            className={styles.btn}
            disabled={pending}
            onClick={() => void perform(async () => apply(await client.pause(run.id)))}
          >
            Pause
          </button>
        )}
        {run.status === 'stale' && (
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={pending}
            onClick={() => void perform(async () => apply(await client.resume(run.id)))}
          >
            Resume
          </button>
        )}
        <span className={styles.lanesField}>
          <span className={styles.dim} aria-hidden="true">
            Lanes
          </span>
          <select
            className={styles.control}
            aria-label="Lane count"
            title="The run's lane target (the orchestrator usually sets it)"
            value={run.lanes}
            disabled={pending || settled}
            onChange={(e) => {
              const count = Number(e.target.value)
              void perform(async () => apply(await client.setLanes(run.id, count)))
            }}
          >
            {Array.from({ length: LOOP_MAX_LANES + 1 }, (_, n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </span>
        {prUrl && (
          <button type="button" className={styles.btn} onClick={() => void openExternal(prUrl)}>
            Open PR
          </button>
        )}
        <ArchiveButton
          disabled={pending}
          onConfirm={() =>
            void perform(async () => {
              await client.archive(run.id)
              onOpenRun(null)
            })
          }
        />
      </header>
      {(run.note || error) && (
        <div className={styles.notices}>
          {run.note && <span className={styles.dim}>{run.note}</span>}
          {error && (
            <span role="alert" className={styles.error}>
              {error}
            </span>
          )}
        </div>
      )}
      <div className={styles.grid}>
        <div className={styles.chatCell}>
          <LoopChat
            events={events}
            partial={partial}
            busy={view.orchestratorBusy}
            alive={view.orchestratorAlive}
            onSend={(text) => client.chat(run.id, text)}
          />
        </div>
        <div className={styles.lanesCell}>
          <LoopLanes
            view={view}
            active={active}
            onStop={(n) => void perform(async () => apply(await client.stopTicket(run.id, n)))}
          />
        </div>
        <div className={styles.mapCell}>
          <LoopMap tickets={view.tickets} />
        </div>
      </div>
    </section>
  )
}

/**
 * The Loop mode root (desktop only — the phone shell never shows it). With no
 * run open it is a run picker plus a new-run form; with one open it is a slim
 * header and a FIXED grid: the orchestrator chat full-height on the left third,
 * the lane windows above the ticket map on the right two thirds. No dragging or
 * resizing, by scope. All state lives in App (fed by the `/ws` loop frames);
 * this component only owns transient UI state (confirms, pending, errors).
 */
export function LoopView({
  runs,
  openRunId,
  view,
  events,
  partial,
  loadError = null,
  repos,
  active,
  onOpenRun,
  onCreate,
  onView,
  client = loopApi,
}: Props) {
  if (!openRunId) {
    return <RunPicker runs={runs} repos={repos} onOpenRun={onOpenRun} onCreate={onCreate} />
  }
  if (!view || view.run.id !== openRunId) {
    return (
      <section className={styles.root} aria-label="Loop run">
        <header className={styles.header}>
          <button type="button" className={styles.btn} onClick={() => onOpenRun(null)}>
            All runs
          </button>
        </header>
        {loadError ? (
          <div role="alert" className={`${styles.loading} ${styles.error}`}>
            Could not load this run: {loadError}
          </div>
        ) : (
          <div className={styles.loading}>Loading run…</div>
        )}
      </section>
    )
  }
  return (
    // Keyed by run so confirms/errors never leak from one run into the next.
    <RunPane
      key={view.run.id}
      view={view}
      events={events}
      partial={partial}
      repos={repos}
      active={active}
      onOpenRun={onOpenRun}
      onView={onView}
      client={client}
    />
  )
}
