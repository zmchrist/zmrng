import { useCallback, useRef, useState } from 'react'

const BOTTOM_THRESHOLD_PX = 32

/** Pure so it's testable without a real layout engine (jsdom reports 0 for
 *  scrollHeight/clientHeight, so tests exercise this with plain objects). */
export function isNearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = BOTTOM_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

/**
 * Bottom-pin auto-scroll for a live message list (WorkerLog, ChatPane, and
 * any future agent-chat-style list): jumps to the bottom when new content
 * lands only if the user was already at/near the bottom. If they've scrolled
 * up to read history, new content appends without stealing scroll position
 * and `hasNew` flips true until they scroll back down or call
 * `scrollToBottom`.
 *
 * Usage: spread `ref`/`onScroll` onto the scrollable container, and call
 * `notifyContentChanged()` from a `useEffect` keyed on whatever grows the list.
 */
export function useAutoScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const pinnedRef = useRef(true)
  const [hasNew, setHasNew] = useState(false)

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const atBottom = isNearBottom(el)
    pinnedRef.current = atBottom
    if (atBottom) setHasNew(false)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    pinnedRef.current = true
    setHasNew(false)
  }, [])

  const notifyContentChanged = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight
    } else {
      setHasNew(true)
    }
  }, [])

  return { ref, onScroll, scrollToBottom, notifyContentChanged, hasNew }
}
