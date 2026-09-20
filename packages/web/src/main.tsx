import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import App from './App'
import { applyTheme, loadStoredTheme } from './themes'
import { applyOpacity, loadStoredOpacity } from './opacity'

// `crypto.randomUUID` only exists in a secure context (HTTPS or localhost). When
// zmrng is served over plain HTTP to a raw LAN/tailnet IP — the normal way the
// headless VPS orchestrator is reached — the function is undefined and the app
// crashes at first render. Polyfill it from `crypto.getRandomValues` (which IS
// available in insecure contexts) so the UI mounts anywhere. RFC 4122 v4.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  ;(crypto as Crypto & { randomUUID: () => string }).randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'))
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}` as `${string}-${string}-${string}-${string}-${string}`
  }
}

// Apply any stored theme before first paint so a returning user never sees a
// flash of the default orange/dark look.
const stored = loadStoredTheme()
applyTheme(stored.themeId, stored.mode)
// Apply the stored surface opacity too so returning users keep their glass look.
applyOpacity(loadStoredOpacity())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
