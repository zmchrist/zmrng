import { describe, it, expect, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatCard } from '../src/components/ChatCard'
import { hydrateChatTabs, type ChatTabState, type TabsState } from '../src/windowTabs'
import { loadChatThread, saveChatThread } from '../src/chatPersistence'

// A fresh, unlaunched default tab never mounts `ChatPane`, so this renders
// without opening a `/ws/chat` socket — no network mock needed.
function Harness({ initial }: { initial: TabsState<ChatTabState> }) {
  const [tabs, setTabs] = useState(initial)
  return <ChatCard tabs={tabs} onTabsChange={setTabs} repos={[]} />
}

describe('ChatCard close', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('purges the closed tab\'s saved transcript so its history cannot leak', () => {
    // A tab whose old conversation is already persisted in localStorage.
    saveChatThread('chat-1', [{ kind: 'user', text: 'old convo' }])
    const initial = hydrateChatTabs({
      tabs: [
        { id: 'chat-1', label: 'Chat 1', model: 'sonnet', effort: 'medium', style: 'caveman-full', repoId: '', launched: false },
      ],
      activeId: 'chat-1',
    })

    render(<Harness initial={initial} />)
    expect(loadChatThread('chat-1')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close Chat 1' }))

    // Transcript gone → a later tab reusing the id gets a blank thread.
    expect(loadChatThread('chat-1')).toEqual([])
    expect(screen.queryByText('Chat 1')).toBeNull()
  })
})
