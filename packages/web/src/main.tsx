import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import App from './App'
import { applyTheme, loadStoredTheme } from './themes'
import { applyOpacity, loadStoredOpacity } from './opacity'

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
