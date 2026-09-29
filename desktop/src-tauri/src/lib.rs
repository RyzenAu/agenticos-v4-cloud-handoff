mod config;
mod server_log;
mod starting_page;
mod supervisor;
#[cfg(windows)]
mod external_links;
#[cfg(windows)]
mod nav_watch;
#[cfg(windows)]
mod webview_permissions;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use supervisor::{ServerVersion, Status, Supervisor, Ui};

/// The shell's own version (`Cargo.toml`) and the commit it was built from
/// (`build.rs`, with a `-dirty` marker). The *OS* version in the title comes
/// from the running server's `/__version` once it answers — before 28 Sep
/// 2026 the title baked in the build machine's HEAD, which said nothing about
/// the server actually running.
const SHELL_VERSION: &str = env!("CARGO_PKG_VERSION");
const SHELL_BUILD: &str = env!("JARVIS_SHELL_BUILD");
const TRAY_ID: &str = "jarvis";

fn show_and_focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Native message box for "Restart OS server" when the live server belongs to
/// the Startup supervisor (so there's nothing for this app to restart).
fn notify_not_ours(port: u16) {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};
        let title = HSTRING::from("Jarvis");
        let text = HSTRING::from(format!(
            "The server on 127.0.0.1:{port} was started by the Startup supervisor, not by \
             this window, so Jarvis won't restart it here.\n\nRestart it from the supervisor \
             instead."
        ));
        unsafe {
            MessageBoxW(None, &text, &title, MB_OK | MB_ICONINFORMATION);
        }
    }
    #[cfg(not(windows))]
    let _ = port;
}

/// The supervision loop's view of the window. Every call is queued onto the
/// main thread: window handles are thread-affine on Windows.
struct TauriUi {
    app: AppHandle,
    prefix: &'static str,
    label: Mutex<String>,
    shown_app_once: AtomicBool,
}

impl TauriUi {
    fn label(&self) -> String {
        self.label.lock().map(|l| l.clone()).unwrap_or_default()
    }

    fn on_main(&self, what: &'static str, f: impl FnOnce(tauri::WebviewWindow) + Send + 'static) {
        let handle = self.app.clone();
        if let Err(err) = self.app.run_on_main_thread(move || match handle.get_webview_window("main") {
            Some(window) => f(window),
            None => log::error!("Jarvis: no `main` window for {what}"),
        }) {
            log::error!("Jarvis: couldn't queue {what} on the main thread: {err}");
        }
    }
}

impl Ui for TauriUi {
    fn show_app(&self, url: &str) {
        let Ok(parsed) = url.parse::<tauri::Url>() else {
            log::error!("Jarvis: not a URL: {url}");
            return;
        };
        let first = !self.shown_app_once.swap(true, Ordering::SeqCst);
        self.on_main("navigate to the app", move |window| {
            if let Err(err) = window.navigate(parsed) {
                log::error!("Jarvis: navigate() to the app failed: {err}");
            }
            if first {
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
    }

    fn show_status_page(&self, status: &Status) {
        let url = starting_page::starting_page_url(&self.label(), &status.headline, &status.detail, status.phase.as_str());
        self.on_main("show the status page", move |window| {
            if let Err(err) = window.navigate(url) {
                log::error!("Jarvis: couldn't show the status page: {err}");
            }
        });
    }

    fn update_status(&self, status: &Status) {
        let script = starting_page::status_script(&status.headline, &status.detail, status.phase.as_str());
        self.on_main("update the status page", move |window| {
            let _ = window.eval(&script);
        });
    }

    fn current_url(&self) -> Option<String> {
        self.app.get_webview_window("main")?.url().ok().map(|u| u.to_string())
    }

    fn set_version(&self, version: &ServerVersion) {
        let label = format!("{}{}", self.prefix, version.label(SHELL_VERSION));
        log::info!("Jarvis: server identifies as {label}");
        if let Ok(mut current) = self.label.lock() {
            *current = label.clone();
        }
        if let Some(tray) = self.app.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some(&label));
        }
        self.on_main("set the title", move |window| {
            let _ = window.set_title(&label);
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = config::load();
    config::set_app_port(config.port);
    let test_instance = config.is_test_instance();

    let mut builder = tauri::Builder::default();
    if !test_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_and_focus_main(app);
        }));
    }

    builder
        .setup(move |app| {
            // On in every build: a packaged run otherwise leaves no evidence.
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            let prefix: &'static str = if test_instance { "[test] " } else { "" };
            let port = config.port;
            log::info!(
                "Jarvis: shell {SHELL_VERSION} ({SHELL_BUILD}); OS checkout {} on port {port} (from {}){}",
                config.repo_root.display(),
                config.source,
                if test_instance { "; TEST instance" } else { "" }
            );
            match config::check_repo(&config) {
                config::RepoCheck::Ok => {}
                config::RepoCheck::Warning(w) => log::warn!("Jarvis: {w}"),
                config::RepoCheck::Invalid(e) => log::error!("Jarvis: can't spawn from here: {e}"),
            }
            match config::resolve_bun(&config) {
                Ok(bun) => log::info!("Jarvis: bun = {}", bun.display()),
                Err(e) => log::error!("Jarvis: {e}"),
            }

            let log_dir = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("jarvis-logs"));
            let log_name = if test_instance { "server-test.log" } else { "server.log" };
            let server_log = server_log::shared(log_dir.join(log_name));
            let supervisor = Arc::new(Supervisor::new(config.clone(), server_log));
            app.manage(supervisor.clone());

            // The main window is declared in tauri.conf.json with `create: false`
            // and built here, so a test instance can get its own WebView2 profile
            // (two processes can't share one with different browser arguments).
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("`main` window declared in tauri.conf.json");
            let mut window_builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?;
            if test_instance {
                if let Ok(dir) = app.path().app_local_data_dir() {
                    window_builder = window_builder.data_directory(dir.join("EBWebView-test"));
                }
            }
            let window = window_builder.build()?;

            #[cfg(windows)]
            {
                let _ = webview_permissions::allow_microphone_for_localhost(&window);
                let _ = external_links::open_links_externally(&window);
                let _ = nav_watch::report_navigation_outcomes(&window, supervisor.clone());
            }

            let label = format!("{prefix}Jarvis \u{b7} shell {SHELL_VERSION}");
            let _ = window.set_title(&label);
            let first = starting_page::starting_page_url(
                &label,
                "Starting Jarvis\u{2026}",
                &format!("Checking the local server on 127.0.0.1:{port}."),
                "starting",
            );
            if let Err(err) = window.navigate(first) {
                log::error!("Jarvis: couldn't navigate to the starting page: {err}");
            }
            if let Err(err) = window.show() {
                log::error!("Jarvis: couldn't show the window: {err}");
            }

            // Global shortcut: Ctrl+Shift+Space shows + focuses the window.
            // Non-fatal if another app owns it; skipped for a test instance.
            if !test_instance {
                let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                let app_handle = app.handle().clone();
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |_app, received, event| {
                            if *received == shortcut && event.state() == ShortcutState::Pressed {
                                show_and_focus_main(&app_handle);
                            }
                        })
                        .build(),
                )?;
                if let Err(err) = app.global_shortcut().register(shortcut) {
                    log::warn!("Jarvis: couldn't register Ctrl+Shift+Space (probably owned by another app): {err}");
                }
            }

            // Tray icon + menu.
            let show_item = MenuItemBuilder::with_id("show", "Show Jarvis").build(app)?;
            let restart_item = MenuItemBuilder::with_id("restart", "Restart OS server").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &restart_item, &quit_item])
                .build()?;
            {
                let supervisor_for_menu = supervisor.clone();
                TrayIconBuilder::with_id(TRAY_ID)
                    .icon(app.default_window_icon().cloned().expect("app icon"))
                    .tooltip(&label)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| match event.id().as_ref() {
                        "show" => show_and_focus_main(app),
                        "restart" => {
                            if !supervisor_for_menu.request_restart() {
                                notify_not_ours(supervisor_for_menu.config.port);
                            }
                        }
                        "quit" => {
                            supervisor_for_menu.kill_our_tree();
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_and_focus_main(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            // Closing the window hides it to tray instead of quitting.
            {
                let window_for_close = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                });
            }

            // One loop owns attach/spawn/restart and every navigation away from
            // (and back to) the status page — see supervisor.rs.
            let ui = TauriUi {
                app: app.handle().clone(),
                prefix,
                label: Mutex::new(label),
                shown_app_once: AtomicBool::new(false),
            };
            std::thread::spawn(move || supervisor.run(&ui));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
