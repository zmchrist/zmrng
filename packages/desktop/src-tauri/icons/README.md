# App icons

The macOS icon set the bundler references (`32x32.png`, `128x128.png`,
`128x128@2x.png`, `icon.icns`) is **committed** so a fresh clone can run
`tauri build` directly. The cross-platform variants `tauri icon` also emits
(android/, ios/, `Square*Logo.png`, `StoreLogo.png`, `icon.ico`) are gitignored.

Regenerate the whole set from the source logo (`packages/desktop/zmrngApp.png`,
1024×1024) after a redesign:

```bash
npm run tauri -w @zmrng/desktop -- icon "$PWD/packages/desktop/zmrngApp.png"
```
