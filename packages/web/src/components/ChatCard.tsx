import { useCallback } from 'react'
import styles from './WindowTabs.module.css'
import { TabStrip } from './TabStrip'
import { ChatPane } from './ChatPane'
import {
  addChatTab,
  closeTab,
  launchChatTab,
  nextLabel,
  setActiveTab,
  setChatTabConfig,
  type ChatTabState,
  type TabsState,
} from '../windowTabs'
import type { CaveStyle, EffortLevel, ModelAlias, RepoTarget } from '../types'

interface Props {
  tabs: TabsState<ChatTabState>
  onTabsChange: (next: TabsState<ChatTabState>) => void
  /** Same repo registry as task creation (`GET /api/repos`). */
  repos: RepoTarget[]
}

const MODEL_OPTIONS: readonly ModelAlias[] = ['sonnet', 'opus']
const EFFORT_OPTIONS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STYLE_OPTIONS: readonly CaveStyle[] = [
  'normal',
  'caveman-lite',
  'caveman-full',
  'caveman-ultra',
  'wenyan-full',
]

/** New-tab default config — independent of the task-level DEFAULT_* controls. */
const NEW_TAB_DEFAULTS = {
  model: 'sonnet' as ModelAlias,
  effort: 'medium' as EffortLevel,
  style: 'caveman-full' as CaveStyle,
  /** `''` = "Projects root" (`config.projectsDir`), the default. */
  repoId: '',
}

/**
 * The Chat card's own tab strip: `+` opens a new unlaunched tab, each tab has
 * an `×` to close. An unlaunched tab shows a model/effort/style/repo picker
 * gated behind a Launch button — the `/ws/chat` session (`ChatPane`) only
 * mounts once Launch is pressed, so a fresh tab (including the very first
 * one) never auto-spawns a session. The repo choice seeds the live pane's own
 * Repo select (`ChatPane`), where it can be changed the same way as
 * model/effort/style. All tabs stay mounted
 * (`display:none` when inactive) so switching tabs never kills a live
 * session, matching the existing hide/show-survives-session policy for this
 * card.
 */
export function ChatCard({ tabs, onTabsChange, repos }: Props) {
  const addTab = useCallback(() => {
    const id = `chat-${crypto.randomUUID()}`
    onTabsChange(addChatTab(tabs, id, nextLabel('Chat', tabs), NEW_TAB_DEFAULTS))
  }, [tabs, onTabsChange])

  const closeThisTab = useCallback((id: string) => onTabsChange(closeTab(tabs, id)), [tabs, onTabsChange])
  const activate = useCallback((id: string) => onTabsChange(setActiveTab(tabs, id)), [tabs, onTabsChange])
  const launch = useCallback((id: string) => onTabsChange(launchChatTab(tabs, id)), [tabs, onTabsChange])
  const setConfig = useCallback(
    (id: string, patch: Partial<Pick<ChatTabState, 'model' | 'effort' | 'style' | 'repoId'>>) =>
      onTabsChange(setChatTabConfig(tabs, id, patch)),
    [tabs, onTabsChange],
  )

  return (
    <div className={styles.card}>
      <TabStrip
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        onActivate={activate}
        onClose={closeThisTab}
        onAdd={addTab}
        addLabel="New chat"
      />
      <div className={styles.body}>
        {tabs.tabs.length === 0 && <div className={styles.empty}>No chat tabs. Click + to start one.</div>}
        {tabs.tabs.map((t) => (
          <div key={t.id} className={styles.tabBody} style={{ display: t.id === tabs.activeId ? 'flex' : 'none' }}>
            {t.launched ? (
              <ChatPane
                id={t.id}
                initialModel={t.model}
                initialEffort={t.effort}
                initialStyle={t.style}
                initialRepoId={t.repoId}
                repos={repos}
              />
            ) : (
              <div className={styles.launch}>
                <span className={styles.launchLabel}>Configure this chat</span>
                <div className={styles.launchRow}>
                  <select
                    className={styles.select}
                    aria-label="Model"
                    value={t.model}
                    onChange={(e) => setConfig(t.id, { model: e.target.value as ModelAlias })}
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <select
                    className={styles.select}
                    aria-label="Effort"
                    value={t.effort}
                    onChange={(e) => setConfig(t.id, { effort: e.target.value as EffortLevel })}
                  >
                    {EFFORT_OPTIONS.map((eff) => (
                      <option key={eff} value={eff}>
                        {eff}
                      </option>
                    ))}
                  </select>
                  <select
                    className={styles.select}
                    aria-label="Style"
                    value={t.style}
                    onChange={(e) => setConfig(t.id, { style: e.target.value as CaveStyle })}
                  >
                    {STYLE_OPTIONS.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                  <select
                    className={styles.select}
                    aria-label="Repo"
                    value={t.repoId}
                    onChange={(e) => setConfig(t.id, { repoId: e.target.value })}
                  >
                    <option value="">Projects root</option>
                    {repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="button" className={styles.launchBtn} onClick={() => launch(t.id)}>
                  Launch
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
