// True only inside the native Tauri app (withGlobalTauri exposes this global);
// false in the plain browser dev view, where there are no native traffic lights
// to clear.
export function isTauriRuntime(win: unknown = typeof window !== 'undefined' ? window : undefined): boolean {
  return Boolean(win && typeof win === 'object' && '__TAURI__' in win && (win as { __TAURI__?: unknown }).__TAURI__)
}
