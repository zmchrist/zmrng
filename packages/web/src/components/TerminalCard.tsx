import { useCallback } from 'react'
import styles from './WindowTabs.module.css'
import { TabStrip } from './TabStrip'
import { Terminal } from './Terminal'
import { addTerminalTab, closeTab, nextLabel, setActiveTab, setTerminalTabSession, type TabsState, type TerminalTabState } from '../windowTabs'

interface Props {
  tabs: TabsState<TerminalTabState>
  onTabsChange: (next: TabsState<TerminalTabState>) => void
}

/**
 * The Terminal card's own tab strip: `+` immediately spawns a fresh PTY tab
 * (no config gate, unlike Chat), each tab has an `×` to close. All tabs stay
 * mounted (`display:none` when inactive) so switching tabs never kills a PTY
 * session, matching the existing hide/show-survives-session policy for this
 * card.
 */
export function TerminalCard({ tabs, onTabsChange }: Props) {
  const addTab = useCallback(() => {
    const id = `terminal-${crypto.randomUUID()}`
    onTabsChange(addTerminalTab(tabs, id, nextLabel('Terminal', tabs)))
  }, [tabs, onTabsChange])

  const closeThisTab = useCallback((id: string) => onTabsChange(closeTab(tabs, id)), [tabs, onTabsChange])
  const activate = useCallback((id: string) => onTabsChange(setActiveTab(tabs, id)), [tabs, onTabsChange])
  const rememberSession = useCallback(
    (id: string, sessionId: string) => onTabsChange(setTerminalTabSession(tabs, id, sessionId)),
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
        addLabel="New terminal"
      />
      <div className={styles.body}>
        {tabs.tabs.length === 0 && <div className={styles.empty}>No terminal tabs. Click + to open one.</div>}
        {tabs.tabs.map((t) => (
          <div key={t.id} className={styles.tabBody} style={{ display: t.id === tabs.activeId ? 'flex' : 'none' }}>
            <Terminal id={t.id} sessionId={t.sessionId} onSession={(s) => rememberSession(t.id, s)} />
          </div>
        ))}
      </div>
    </div>
  )
}
