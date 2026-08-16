import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import App from './App'
import { applyTheme, loadStoredTheme } from './themes'

// Apply any stored theme before first paint so a returning user never sees a
// flash of the default orange/dark look.
const stored = loadStoredTheme()
applyTheme(stored.themeId, stored.mode)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
