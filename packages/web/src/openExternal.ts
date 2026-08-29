/** Open a URL in the system's default browser.
 *
 * Inside the Tauri desktop shell, a plain `<a target="_blank">` is silently
 * swallowed by the webview (no `shell:allow-open` capability, no navigation
 * fallback) — so this detects Tauri via `window.__TAURI_INTERNALS__` and
 * routes through `@tauri-apps/plugin-shell`'s `open()` instead. In the dev
 * browser (no Tauri runtime), it falls back to `window.open`.
 *
 * The desktop shell serves the app from the bundled Node sidecar over a remote
 * origin (`http://localhost:<port>`), so the Tauri capability must whitelist
 * that origin under `remote.urls` for `shell:allow-open` to be granted there —
 * otherwise `open()` rejects. We still catch any rejection and fall back to
 * `window.open` so a capability/scope gap can never leave the click dead and
 * silent.
 */
export async function openExternal(url: string): Promise<void> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
      return
    } catch (err) {
      console.error('openExternal: Tauri shell open failed, falling back to window.open', err)
    }
  }
  window.open(url, '_blank', 'noreferrer')
}
