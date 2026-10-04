//! Remote-hub mode: open a hub running on another PC (a private Tailscale
//! HTTPS address such as `https://ryzen-pc.<tailnet>.ts.net:8443`) instead of
//! supervising a local `bun` server.
//!
//! What this mode never does, by construction: spawn `bun`, run the restart
//! loop, check the repo branch, or take the `Local\JarvisAppServer-<port>`
//! mutex (so it can't compete with, or block, a local hub on this PC). The
//! only things it does are navigate the window to the hub and narrate honestly
//! when the hub can't be reached.
//!
//! Reachability is a plain TCP connect to the hub's host and port (the bundled
//! HTTP client has no TLS). The real test of "the page loaded" is WebView2's
//! own `NavigationCompleted`, which `nav_watch.rs` reports through
//! `Supervisor::nav_event` exactly as in local mode.

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use crate::config::{self, DesktopConfig, Hub, HubMode};
use crate::supervisor::{Phase, Status, Supervisor, Ui};

/// How long the hub may be unreachable before the window leaves the app for the "cannot reach" screen.
const SHOW_UNREACHABLE_AFTER: Duration = Duration::from_secs(5);

/// What the app does at startup, decided from the config alone.
#[derive(Debug, PartialEq, Eq)]
pub enum StartupPlan {
    /// No hub URL: the local supervisor runs, exactly as before remote mode existed.
    Local,
    /// Open this origin. No local server, no local supervisor, no mutex.
    OpenHub { origin: String },
    /// The hub URL is not allowed: show the reason; start nothing.
    RejectHubUrl { reason: String },
}

pub fn startup_plan(config: &DesktopConfig) -> StartupPlan {
    match &config.hub {
        HubMode::Local => StartupPlan::Local,
        HubMode::Remote(hub) => StartupPlan::OpenHub { origin: hub.origin.clone() },
        HubMode::Invalid(reason) => StartupPlan::RejectHubUrl { reason: reason.clone() },
    }
}

impl StartupPlan {
    /// May this plan start a local server or hold `Local\JarvisAppServer-<port>`?
    pub fn runs_local_server(&self) -> bool {
        matches!(self, StartupPlan::Local)
    }
}

/// Can we open a TCP connection to the hub right now?
pub fn hub_reachable(hub: &Hub) -> bool {
    let Ok(addrs) = (hub.host.as_str(), hub.port).to_socket_addrs() else { return false };
    addrs.into_iter().any(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(3)).is_ok())
}

/// The honest "can't reach it" state, with the address in the headline.
pub fn unreachable_status(hub: &Hub, down_for: Duration) -> Status {
    Status {
        phase: Phase::Recovering,
        headline: format!("Cannot reach the hub at {}", hub.origin),
        detail: format!(
            "Nothing answered on {}:{} ({}s). Check that the hub PC is on and Tailscale is connected on this PC. \
             Jarvis keeps retrying; \"Reload hub\" in the tray tries right now. No local server is started in this mode.",
            hub.host,
            hub.port,
            down_for.as_secs()
        ),
    }
}

/// The hub answers on its port but the page failed to load.
pub fn page_failed_status(hub: &Hub, webview_error: i32, retry_in: Duration) -> Status {
    Status {
        phase: Phase::Recovering,
        headline: format!("Cannot reach the hub at {}", hub.origin),
        detail: format!(
            "The hub's page didn't load (WebView2 error {webview_error}). Trying again in {}s; \"Reload hub\" in the tray tries now.",
            retry_in.as_secs()
        ),
    }
}

/// The settings are wrong: say so, once, and stop.
pub fn rejected_status(reason: &str) -> Status {
    Status {
        phase: Phase::Stopped,
        headline: "Jarvis won't open this hub address".to_string(),
        detail: format!("{reason} Fix hubUrl (or JARVIS_HUB_URL), then restart Jarvis. No local server was started."),
    }
}

/// Where "Reload hub" goes: the window's current page when it is on the hub origin, else the page
/// we were on before the status screen, else the hub root.
pub fn reload_target(current: Option<String>, last: Option<&str>, origin: &str) -> String {
    current
        .filter(|u| config::origin_matches(u, origin))
        .or_else(|| last.map(str::to_string))
        .unwrap_or_else(|| origin.to_string())
}

/// The remote-mode loop. Runs for the lifetime of the app; touches no process or mutex.
pub fn run(supervisor: &Supervisor, hub: &Hub, ui: &dyn Ui) {
    let mut showing_app = false;
    let mut shown_status: Option<Status> = None;
    let mut last_app_url: Option<String> = None;
    let mut down_since: Option<Instant> = None;
    let mut nav_failures: u32 = 0;
    let mut retry_at: Option<Instant> = None;
    log::info!("Jarvis: remote hub mode, opening {} (no local server)", hub.origin);

    loop {
        let now = Instant::now();
        if supervisor.take_reload_request() {
            log::info!("Jarvis: reload hub requested from the tray");
            nav_failures = 0;
            retry_at = None;
            if showing_app {
                ui.show_app(&reload_target(ui.current_url(), last_app_url.as_deref(), &hub.origin));
            }
        }

        if hub_reachable(hub) {
            down_since = None;
            match supervisor.nav_event.swap(0, Ordering::SeqCst) {
                -1 => nav_failures = 0,
                code if code > 0 && showing_app => {
                    nav_failures += 1;
                    let delay = Duration::from_secs((1u64 << nav_failures.min(5)).min(30));
                    log::warn!("Jarvis: hub page failed (status {}), retry {nav_failures} in {delay:?}", code - 1);
                    if let Some(url) = ui.current_url().filter(|u| config::origin_matches(u, &hub.origin)) {
                        last_app_url = Some(url);
                    }
                    let status = page_failed_status(hub, code - 1, delay);
                    ui.show_status_page(&status);
                    shown_status = Some(status);
                    showing_app = false;
                    retry_at = Some(now + delay);
                }
                _ => {}
            }
            if !showing_app && retry_at.map_or(true, |t| now >= t) {
                let target = last_app_url.clone().unwrap_or_else(|| hub.origin.clone());
                log::info!("Jarvis: hub reachable, showing {target}");
                ui.show_app(&target);
                last_app_url = None; // the hub page is showing again; a later reload uses the live URL
                showing_app = true;
                shown_status = None;
                retry_at = None;
            }
            std::thread::sleep(Duration::from_secs(if showing_app { 3 } else { 1 }));
            continue;
        }

        let down_for = now.duration_since(*down_since.get_or_insert(now));
        if showing_app && down_for >= SHOW_UNREACHABLE_AFTER {
            if let Some(url) = ui.current_url().filter(|u| config::origin_matches(u, &hub.origin)) {
                last_app_url = Some(url);
            }
            showing_app = false;
            shown_status = None;
            log::warn!("Jarvis: the hub at {} stopped answering; showing the cannot-reach screen", hub.origin);
        }
        if !showing_app {
            let status = unreachable_status(hub, down_for);
            match &shown_status {
                None => ui.show_status_page(&status),
                Some(prev) if *prev != status => ui.update_status(&status),
                _ => {}
            }
            shown_status = Some(status);
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn unique_temp(name: &str) -> std::path::PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("jarvis-remote-test-{}-{n}-{name}", std::process::id()))
    }

    fn remote_config(url: &str) -> DesktopConfig {
        remote_config_text(&format!(r#"{{"hubUrl":"{url}"}}"#))
    }

    /// Loads a config the way the app does (`config::load`), from a temp file that is deleted again.
    fn remote_config_text(text: &str) -> DesktopConfig {
        let path = unique_temp("config.json");
        std::fs::write(&path, text).unwrap();
        let cfg = config_from_file(&path);
        let _ = std::fs::remove_file(&path);
        cfg
    }

    fn config_from_file(path: &std::path::Path) -> DesktopConfig {
        let prev = std::env::var_os("JARVIS_DESKTOP_CONFIG");
        let prev_hub = std::env::var_os("JARVIS_HUB_URL");
        std::env::remove_var("JARVIS_HUB_URL");
        std::env::set_var("JARVIS_DESKTOP_CONFIG", path);
        let cfg = config::load();
        match prev {
            Some(v) => std::env::set_var("JARVIS_DESKTOP_CONFIG", v),
            None => std::env::remove_var("JARVIS_DESKTOP_CONFIG"),
        }
        if let Some(v) = prev_hub {
            std::env::set_var("JARVIS_HUB_URL", v);
        }
        cfg
    }

    // `config::load` reads process-wide env vars; run the tests that touch it one at a time.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// A panicking test must not poison the lock for the others.
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn a_broken_config_file_plans_an_error_not_a_local_server() {
        let _guard = lock_env();
        for text in [
            r#"{"hubUrl":"https://ryzen-pc.tail1.ts.net:8443","port":"8443"}"#,
            r#"{"hubUrl":123}"#,
            r#"{"hubUrl":"https://ryzen-pc.tail1.ts.net:8443",}"#,
            r#"{"hubUrl":"https://ryzen-pc.tail1.ts.net:84"#,
        ] {
            let plan = startup_plan(&remote_config_text(text));
            assert!(
                matches!(&plan, StartupPlan::RejectHubUrl { reason } if reason.contains("can't be parsed")),
                "{text}: {plan:?}"
            );
            assert!(!plan.runs_local_server(), "{text} must never start a local hub");
        }
        // A missing file is still local mode.
        let missing = unique_temp("absent.json");
        assert_eq!(startup_plan(&config_from_file(&missing)), StartupPlan::Local);
    }

    #[test]
    fn reload_goes_to_the_live_hub_page_else_the_last_one_else_the_root() {
        let o = "https://ryzen-pc.tail1.ts.net:8443";
        assert_eq!(reload_target(Some(format!("{o}/leads?x=1")), Some(&format!("{o}/old")), o), format!("{o}/leads?x=1"));
        assert_eq!(reload_target(Some("data:text/html,x".into()), Some(&format!("{o}/old")), o), format!("{o}/old"));
        assert_eq!(reload_target(Some("https://evil.example/".into()), None, o), o);
        assert_eq!(reload_target(None, None, o), o);
    }

    #[test]
    fn remote_mode_never_plans_a_local_server_or_mutex() {
        let _guard = lock_env();
        let cfg = remote_config("https://ryzen-pc.tail1.ts.net:8443");
        let plan = startup_plan(&cfg);
        assert_eq!(plan, StartupPlan::OpenHub { origin: "https://ryzen-pc.tail1.ts.net:8443".into() });
        assert!(!plan.runs_local_server());
        assert_eq!(cfg.origin(), "https://ryzen-pc.tail1.ts.net:8443");
        assert_eq!(cfg.supervisor_mutex, None);
    }

    /// R7-G journey A: the installed config on the main PC held `hubUrl` AND a `repoRoot` that is a linked
    /// worktree (the installer wrote its default/-RepoRoot value even in remote mode). Older builds ignore
    /// `hubUrl`, read the worktree and refused to start in a loop ("is a linked git worktree"); this build
    /// must open the hub and never look at the checkout at all.
    #[test]
    fn remote_mode_ignores_a_stale_repo_root_that_is_a_linked_worktree() {
        let _guard = lock_env();
        let cfg = remote_config_text(
            r#"{"repoRoot":"D:\\AgenticOS-ryzen-migration","port":8081,"hubUrl":"https://ryzen-pc.tail1.ts.net:8443"}"#,
        );
        let plan = startup_plan(&cfg);
        assert_eq!(plan, StartupPlan::OpenHub { origin: "https://ryzen-pc.tail1.ts.net:8443".into() });
        assert!(!plan.runs_local_server());
        assert!(cfg.repo_root_is_ignored(), "remote mode must say the checkout is ignored");
        assert_eq!(cfg.app_scope(), config::AppScope::Hub("https://ryzen-pc.tail1.ts.net:8443".into()));
        assert_eq!(cfg.supervisor_mutex, None, "port 8081 must not make a remote app hold the local supervisor mutex");
    }

    #[test]
    fn an_invalid_hub_url_plans_an_error_not_a_local_server() {
        let _guard = lock_env();
        for bad in ["https://evil.example", "https://x.ts.net.evil.com", "http://192.168.1.120:8081"] {
            let cfg = remote_config(bad);
            let plan = startup_plan(&cfg);
            assert!(matches!(&plan, StartupPlan::RejectHubUrl { reason } if reason.contains(bad)), "{bad}: {plan:?}");
            assert!(!plan.runs_local_server(), "{bad} must not fall back to a local hub");
        }
    }

    #[test]
    fn no_hub_url_plans_the_local_supervisor_as_before() {
        let _guard = lock_env();
        let path = std::env::temp_dir().join(format!("jarvis-remote-test-none-{}.json", std::process::id()));
        std::fs::write(&path, "{}").unwrap();
        let cfg = config_from_file(&path);
        let plan = startup_plan(&cfg);
        assert_eq!(plan, StartupPlan::Local);
        assert!(plan.runs_local_server());
    }

    #[test]
    fn a_supervisor_in_remote_mode_refuses_to_spawn_and_never_takes_the_mutex() {
        let _guard = lock_env();
        let cfg = remote_config_text(r#"{"hubUrl":"https://ryzen-pc.tail1.ts.net","port":48123}"#);
        let log_path = unique_temp("server.log");
        let log = crate::server_log::shared(log_path.clone());
        let supervisor = Supervisor::new(cfg, log);
        let err = supervisor.spawn_for_test().unwrap_err();
        assert!(err.contains("remote"), "{err}");
        assert!(!supervisor.spawned_by_us());
        assert!(!supervisor.holds_app_lock(), "the JarvisAppServer mutex must never be taken");
        assert!(!crate::supervisor::named_mutex_exists(&Supervisor::app_mutex_name(48123)), "unique port: a real local app on 8081 can not interfere");
        assert!(!supervisor.request_restart(), "the tray restart does nothing in remote mode");
        let _ = std::fs::remove_file(&log_path);
    }

    #[test]
    fn unreachable_and_failed_states_name_the_hub_and_the_retry() {
        let hub = config::parse_hub_url("https://ryzen-pc.tail1.ts.net:8443").unwrap();
        let s = unreachable_status(&hub, Duration::from_secs(12));
        assert_eq!(s.headline, "Cannot reach the hub at https://ryzen-pc.tail1.ts.net:8443");
        assert!(s.detail.contains("retrying") || s.detail.contains("retry"));
        assert!(s.detail.contains("Reload hub"));
        assert_eq!(s.phase, Phase::Recovering);
        let f = page_failed_status(&hub, 7, Duration::from_secs(4));
        assert!(f.headline.contains("Cannot reach the hub at https://ryzen-pc.tail1.ts.net:8443"));
        assert!(f.detail.contains("error 7") && f.detail.contains("4s"));
        let r = rejected_status("hubUrl \"x\" is not allowed.");
        assert_eq!(r.phase, Phase::Stopped);
        assert!(r.detail.contains("No local server"));
    }

    #[test]
    fn an_unresolvable_hub_is_unreachable_not_a_panic() {
        let hub = Hub { origin: "https://nope.invalid".into(), host: "nope.invalid".into(), port: 443 };
        assert!(!hub_reachable(&hub));
    }
}
