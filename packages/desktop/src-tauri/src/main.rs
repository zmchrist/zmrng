// zmrng desktop shell.
//
// Responsibilities (the Node engine itself is unchanged — we only wrap it):
//   1. pick a free localhost port
//   2. resolve the user's real login-shell PATH (Finder-launched apps get a
//      minimal PATH; without this the sidecar can't find claude/git/gh)
//   3. spawn the bundled Node server as a sidecar with the right env
//   4. health-poll the port, then navigate the window to the server URL
//   5. on quit, SIGTERM the sidecar so its handler reaps the claude children
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Listener, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the live sidecar child so we can terminate it on quit.
struct Sidecar(Mutex<Option<CommandChild>>);

/// Two-signal boot handshake. `engine-ready` is emitted exactly once, only after
/// BOTH the sidecar port is up AND the splash JS has registered its listener —
/// this prevents the event racing ahead of the splash and stranding the app.
struct Boot {
    port: u16,
    sidecar: bool,
    splash: bool,
    emitted: bool,
}

/// Emit `engine-ready { port }` exactly once, when both halves are ready. The
/// splash owns navigation from here (it has the port from the payload).
fn try_emit_ready(app: &tauri::AppHandle) {
    let state = app.state::<Mutex<Boot>>();
    let mut boot = state.lock().unwrap();
    if boot.sidecar && boot.splash && !boot.emitted {
        boot.emitted = true;
        let port = boot.port;
        drop(boot);
        let _ = app.emit("engine-ready", port);
    }
}

/// Bind :0 to let the OS hand us a free port, then release it. Tiny TOCTOU
/// window before the sidecar binds it — acceptable for a single-user app.
fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(4500)
}

/// Resolve the interactive login-shell PATH so the sidecar can find claude,
/// git, and gh. Falls back to common Homebrew/system locations.
fn login_shell_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let path = std::process::Command::new(&shell)
        .args(["-lic", "printf %s \"$PATH\""])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if path.is_empty() {
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".into()
    } else {
        path
    }
}

/// SIGTERM the sidecar (so Node's handler runs `manager.shutdown()` and kills
/// its claude children), give it a beat, then hard-kill as a backstop.
fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(child) = app.state::<Sidecar>().0.lock().unwrap().take() {
        let pid = child.pid() as i32;
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(800));
        let _ = child.kill();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let port = pick_free_port();
            let path = login_shell_path();

            // Shared boot-handshake state — sidecar-up + splash-ready both flip it.
            app.manage(Mutex::new(Boot {
                port,
                sidecar: false,
                splash: false,
                emitted: false,
            }));

            // Splash JS announces it has registered its `engine-ready` listener.
            let listen_handle = app.handle().clone();
            app.listen("splash-ready", move |_event| {
                {
                    let state = listen_handle.state::<Mutex<Boot>>();
                    state.lock().unwrap().splash = true;
                }
                try_emit_ready(&listen_handle);
            });

            // Writable per-user data dir (db, worktrees, repo registry) — never
            // inside the read-only app bundle.
            let data_dir = app
                .path()
                .home_dir()?
                .join("Library/Application Support/zmrng");
            std::fs::create_dir_all(&data_dir)?;

            let resource_dir = app.path().resource_dir()?;
            let server_js = resource_dir.join("sidecar/server.mjs");
            let web_dist = resource_dir.join("web-dist");

            let envs: HashMap<String, String> = HashMap::from([
                ("ZMRNG_PORT".into(), port.to_string()),
                ("ZMRNG_DATA_DIR".into(), data_dir.to_string_lossy().into_owned()),
                ("ZMRNG_WEB_DIST".into(), web_dist.to_string_lossy().into_owned()),
                ("PATH".into(), path),
            ]);

            let (mut rx, child) = app
                .shell()
                .sidecar("node")?
                .args([server_js.to_string_lossy().into_owned()])
                .envs(envs)
                .spawn()?;

            app.state::<Sidecar>().0.lock().unwrap().replace(child);

            // Drain the sidecar's stdout/stderr so its pipe never fills and stalls.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stderr(bytes) | CommandEvent::Stdout(bytes) = event {
                        // Forward to stderr for `tauri dev` visibility.
                        eprint!("[sidecar] {}", String::from_utf8_lossy(&bytes));
                    }
                }
            });

            // Health-poll the port on a background thread (up to ~15s). On success
            // flag the sidecar ready and try to fire the handshake — the splash,
            // not Rust, navigates the window to the live server.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let addr = format!("127.0.0.1:{port}");
                for _ in 0..75 {
                    if TcpStream::connect(&addr).is_ok() {
                        {
                            let state = handle.state::<Mutex<Boot>>();
                            state.lock().unwrap().sidecar = true;
                        }
                        try_emit_ready(&handle);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                kill_sidecar(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building zmrng")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(app);
            }
        });
}
