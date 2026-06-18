import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted Bricolage Grotesque (variable) — bundled by Vite, no runtime CDN.
import '@fontsource-variable/bricolage-grotesque/index.css'
import './theme.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
