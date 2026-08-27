/** Open a URL in the system's default browser.
 *
 * Inside the Tauri desktop shell, a plain `<a target="_blank">` is silently
 * swallowed by the webview (no `shell:allow-open` capability, no navigation
 * fallback) — so this detects Tauri via `window.__TAURI_INTERNALS__` and
 * routes through `@tauri-apps/plugin-shell`'s `open()` instead. In the dev
 * browser (no Tauri runtime), it falls back to `window.open`.
 */
export async function openExternal(url: string): Promise<void> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
    return
  }
  window.open(url, '_blank', 'noreferrer')
}
