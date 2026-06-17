import { useEffect, useRef, useState } from 'react'
import type { WsEvent } from './types'

/** Auto-reconnecting WebSocket hook (ported from Pheme's useWebSocket). */
export function useWs(onEvent: (e: WsEvent) => void) {
  const [connected, setConnected] = useState(false)
  const onEventRef = useRef(onEvent)
  const mountedRef = useRef(true)
  const retryRef = useRef(1000)
  const activeRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    onEventRef.current = onEvent
  })

  useEffect(() => {
    mountedRef.current = true
    retryRef.current = 1000

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

    function connect() {
      if (!mountedRef.current) return
      const ws = new WebSocket(url)
      activeRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        retryRef.current = 1000
      }
      ws.onmessage = (event) => {
        try {
          onEventRef.current(JSON.parse(event.data) as WsEvent)
        } catch {
          // ignore malformed frames
        }
      }
      ws.onclose = () => {
        if (ws !== activeRef.current) return
        setConnected(false)
        if (mountedRef.current) {
          setTimeout(connect, retryRef.current)
          retryRef.current = Math.min(retryRef.current * 2, 30000)
        }
      }
      ws.onerror = () => ws.close()
    }

    connect()
    return () => {
      mountedRef.current = false
      const ws = activeRef.current
      activeRef.current = null
      ws?.close()
    }
  }, [])

  return { connected }
}
