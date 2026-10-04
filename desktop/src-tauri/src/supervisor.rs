//! Supervises the Agentic OS Bun dev server that serves the web app.
//!
//! Behaviour (see docs/DESKTOP-APP.md, "Supervisor v2, 28 Sep 2026"):
//! - On start: if the port is already accepting TCP connections, attach to
//!   it and leave it alone (it belongs to the Startup .vbs +
//!   `scripts/windows/agentic-os-supervisor.ps1`, or a previous run).
//! - Otherwise spawn the server ourselves from the configured checkout
//!   (`config.rs`: runtime repo root, the real `bun.exe`, never a shim), with
//!   no console window, `BROWSER=none`, and its output in a rotating
//!   `server.log`.
//! - One loop owns every decision (`run`): it health-checks `/__token`,
//!   respawns a server *we* own when it exits (including during boot, which
//!   the old readiness-gated loop never did), adopts the job when an attached
//!   server dies and nobody brings it back (waiting out the PowerShell
//!   supervisor's own restart first while its mutex says it's alive), and
//!   keeps the title in step with `/__version`. It narrates each state to the
//!   window. Restarts are bounded: at most `MAX_RESTARTS` in
//!   `RESTART_WINDOW`, with exponential backoff; past that it shows "stopped"
//!   with the reason and when it will try again.
//! - On quit, kill only the process tree we ourselves spawned.

use std::collections::VecDeque;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::config::{self, DesktopConfig, RepoCheck, SupervisorTimings};
use crate::server_log::{self, SharedLog};

/// Windows `CREATE_NO_WINDOW`, so the spawned Bun process never flashes a console.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const MAX_RESTARTS: usize = 5;
pub const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);
// The adopt grace, boot/hang timeout, stable period and version refresh are
// `config::SupervisorTimings` (test instances can shorten them).
/// How long the window keeps showing the app after the server's port closes
/// before it switches to the recovery screen (rides out a Vite restart).
const SHOW_RECOVERY_AFTER: Duration = Duration::from_secs(5);
/// Same, while the port is still open but `/__token` is slow: the dev server is
/// single-threaded and a cold route transform can stall it for several seconds
/// (seen live: a needless 4s flip to the recovery screen on first load).
const SHOW_RECOVERY_AFTER_BUSY: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Recovering,
    Stopped,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Starting => "starting",
            Phase::Recovering => "recovering",
            Phase::Stopped => "stopped",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub phase: Phase,
    pub headline: String,
    pub detail: String,
}

impl Status {
    fn new(phase: Phase, headline: impl Into<String>, detail: impl Into<String>) -> Self {
        Self { phase, headline: headline.into(), detail: detail.into() }
    }
}

/// What the loop needs from the window. Implemented over Tauri in `lib.rs`;
/// the methods are fire-and-forget (they queue onto the main thread).
pub trait Ui: Send + Sync {
    /// Navigate the window to the app (`url` is an app URL on our origin).
    fn show_app(&self, url: &str);
    /// Navigate the window to the local starting/recovery page.
    fn show_status_page(&self, status: &Status);
    /// Update the text on the starting/recovery page already showing.
    fn update_status(&self, status: &Status);
    /// The window's current URL, if it can be read.
    fn current_url(&self) -> Option<String>;
    /// The running server's identity from `/__version`.
    fn set_version(&self, version: &ServerVersion);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerVersion {
    pub version: String,
    pub git_sha: String,
    pub dirty: bool,
}

impl ServerVersion {
    pub fn label(&self, shell_version: &str) -> String {
        let dirty = if self.dirty { "-dirty" } else { "" };
        format!("Jarvis v{} ({}{dirty}) \u{b7} shell {shell_version}", self.version, self.git_sha)
    }
}

/// When an attached server dies: how long to leave it to its own supervisor
/// before starting one ourselves. Nothing to wait for if we never attached.
pub fn adopt_grace(ever_attached: bool, other_supervisor_alive: bool, timings: &SupervisorTimings) -> Duration {
    match (ever_attached, other_supervisor_alive) {
        (false, _) => Duration::ZERO,
        (true, true) => timings.external_grace,
        (true, false) => timings.adopt_grace,
    }
}

/// How long a live child we own has gone without its port: from the spawn
/// while it boots, or from when it stopped answering once it had been healthy
/// long enough to reset the budget (before 28 Sep that case read 0 s forever,
/// so a server that hung after a healthy spell was never killed).
pub fn hang_clock(since_spawn: Option<Duration>, down_for: Duration) -> Duration {
    since_spawn.unwrap_or(down_for)
}

/// Re-reads `/__version` while the server is healthy. Vite reloads its config
/// in place when the checkout moves (a fast-forward merge), so the server's
/// identity can change without a restart; before 28 Sep the title kept the
/// first answer (seen live: title 43ec3c8 while the server reported f334ab7).
pub struct VersionWatch {
    every: Duration,
    last_check: Option<Instant>,
    current: Option<ServerVersion>,
    announced: bool,
}

impl VersionWatch {
    pub fn new(every: Duration) -> Self {
        Self { every, last_check: None, current: None, announced: false }
    }

    /// True when it's time to read `/__version` again.
    pub fn due(&self, now: Instant) -> bool {
        self.last_check.map_or(true, |t| now.duration_since(t) >= self.every)
    }

    /// Record an answer (or `None` for a failed read). Returns the version to
    /// show when the title needs updating: a new identity, or the first
    /// answer after `reset` (a restart or recovery).
    pub fn observe(&mut self, now: Instant, answer: Option<ServerVersion>) -> Option<ServerVersion> {
        self.last_check = Some(now);
        let version = answer?;
        let changed = self.current.as_ref() != Some(&version) || !self.announced;
        self.current = Some(version.clone());
        self.announced = true;
        changed.then_some(version)
    }

    /// The server went away: read it again as soon as it answers.
    pub fn reset(&mut self) {
        self.last_check = None;
        self.announced = false;
    }
}

/// Sliding-window restart budget with exponential backoff.
pub struct RestartBudget {
    max: usize,
    window: Duration,
    history: VecDeque<Instant>,
}

impl RestartBudget {
    pub fn new(max: usize, window: Duration) -> Self {
        Self { max, window, history: VecDeque::new() }
    }

    fn prune(&mut self, now: Instant) {
        while let Some(first) = self.history.front() {
            if now.duration_since(*first) >= self.window {
                self.history.pop_front();
            } else {
                break;
            }
        }
    }

    /// Records an attempt if the budget allows one now.
    pub fn take(&mut self, now: Instant) -> bool {
        self.prune(now);
        if self.history.len() >= self.max {
            return false;
        }
        self.history.push_back(now);
        true
    }

    pub fn used(&mut self, now: Instant) -> usize {
        self.prune(now);
        self.history.len()
    }

    /// Delay before the next attempt: 2s, 4s, 8s, 16s, capped at 30s.
    pub fn backoff(&mut self, now: Instant) -> Duration {
        match self.used(now) as u32 {
            0 => Duration::ZERO,
            n => Duration::from_secs((2u64 << (n - 1).min(5)).min(30)),
        }
    }

    /// Time until an attempt is allowed again (zero if allowed now).
    pub fn wait_time(&mut self, now: Instant) -> Duration {
        self.prune(now);
        if self.history.len() < self.max {
            return Duration::ZERO;
        }
        self.history
            .front()
            .map(|first| self.window.saturating_sub(now.duration_since(*first)))
            .unwrap_or(Duration::ZERO)
    }

    pub fn reset(&mut self) {
        self.history.clear();
    }
}

/// Shared state for the one Bun server this app may or may not own.
pub struct Supervisor {
    pub config: DesktopConfig,
    child: Mutex<Option<Child>>,
    /// True only if *this app* spawned the currently-tracked child. The tray
    /// "Restart OS server" action and quit-time cleanup both gate on this:
    /// we must never touch a server the PowerShell supervisor started.
    spawned_by_us: AtomicBool,
    /// Set by the tray: kill ours (if any) and start again with a fresh budget.
    manual_restart: AtomicBool,
    /// Held while a server WE started is running or booting: `Local\JarvisAppServer-<port>`. The
    /// PowerShell supervisor sees it and leaves starting, restarting and hang-killing to us (review T8
    /// S-1: exactly one of the two starts a server). A raw handle value, closed when we let go.
    app_lock: Mutex<Option<isize>>,
    /// Last WebView2 navigation outcome for an app URL: 0 none, -1 success,
    /// n > 0 failure with `COREWEBVIEW2_WEB_ERROR_STATUS` n - 1.
    pub nav_event: AtomicI32,
    log: SharedLog,
}

enum ChildState {
    None,
    Running,
    Exited(Option<i32>),
}

impl Supervisor {
    pub fn new(config: DesktopConfig, log: SharedLog) -> Self {
        Self {
            config,
            child: Mutex::new(None),
            spawned_by_us: AtomicBool::new(false),
            manual_restart: AtomicBool::new(false),
            app_lock: Mutex::new(None),
            nav_event: AtomicI32::new(0),
            log,
        }
    }

    pub fn spawned_by_us(&self) -> bool {
        self.spawned_by_us.load(Ordering::SeqCst)
    }

    pub fn server_log_path(&self) -> String {
        self.log.lock().map(|l| l.path().display().to_string()).unwrap_or_default()
    }

    fn addr(&self) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], self.config.port))
    }

    pub fn port_open(&self) -> bool {
        TcpStream::connect_timeout(&self.addr(), Duration::from_millis(300)).is_ok()
    }

    pub fn token_ok(&self) -> bool {
        let url = format!("{}/__token", self.config.loopback_base());
        match ureq::get(&url).timeout(Duration::from_secs(2)).call() {
            Ok(response) => response.status() == 200,
            Err(err) => {
                log::debug!("Jarvis: /__token not ready yet: {err}");
                false
            }
        }
    }

    /// True while another supervisor of this port holds its named mutex (the
    /// Startup PowerShell supervisor on 8081: `Local\AgenticOSSupervisor`).
    pub fn other_supervisor_alive(&self) -> bool {
        self.config.supervisor_mutex.as_deref().map_or(false, named_mutex_exists)
    }

    pub fn fetch_version(&self) -> Option<ServerVersion> {
        let url = format!("{}/__version", self.config.loopback_base());
        let body = ureq::get(&url).timeout(Duration::from_secs(2)).call().ok()?.into_string().ok()?;
        parse_version(&body)
    }

    /// Tray "Restart OS server". Returns false (and does nothing) when the
    /// live server belongs to someone else.
    pub fn request_restart(&self) -> bool {
        if !self.config.is_local() {
            return false;
        }
        if !self.spawned_by_us() && self.port_open() {
            return false;
        }
        self.kill_our_tree();
        self.manual_restart.store(true, Ordering::SeqCst);
        true
    }

    /// Kill the process tree *we* spawned, if any. Never touches a server
    /// this app did not start.
    /// The name of the mutex this app holds while it owns the server on `port`.
    pub fn app_mutex_name(port: u16) -> String {
        format!("Local\\JarvisAppServer-{port}")
    }

    /// Remote-hub mode: the tray's "Reload hub". Picked up by `remote::run`.
    pub fn request_reload(&self) {
        self.manual_restart.store(true, Ordering::SeqCst);
    }

    pub fn take_reload_request(&self) -> bool {
        self.manual_restart.swap(false, Ordering::SeqCst)
    }

    fn hold_app_lock(&self) {
        if !self.config.is_local() {
            return; // remote mode never takes Local\JarvisAppServer-<port>
        }
        let mut lock = self.app_lock.lock().unwrap();
        if lock.is_none() {
            *lock = create_named_mutex(&Self::app_mutex_name(self.config.port));
        }
    }

    fn release_app_lock(&self) {
        if let Some(handle) = self.app_lock.lock().unwrap().take() {
            close_named_mutex(handle);
        }
    }

    #[cfg(test)]
    pub fn spawn_for_test(&self) -> Result<u32, String> {
        self.spawn()
    }

    #[cfg(test)]
    pub fn holds_app_lock(&self) -> bool {
        self.app_lock.lock().unwrap().is_some()
    }

    pub fn kill_our_tree(&self) {
        if !self.spawned_by_us() {
            return;
        }
        let mut guard = self.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            log::info!("Jarvis: stopping our bun server tree (pid {pid})");
            server_log::event(&self.log, &format!("stopping our server tree (pid {pid})"));
            kill_tree(pid);
            let _ = child.wait();
        }
        self.spawned_by_us.store(false, Ordering::SeqCst);
        self.release_app_lock();
    }

    fn child_state(&self) -> ChildState {
        let mut guard = self.child.lock().unwrap();
        match guard.as_mut() {
            None => ChildState::None,
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => ChildState::Exited(status.code()),
                Ok(None) => ChildState::Running,
                Err(_) => ChildState::Exited(None),
            },
        }
    }

    fn forget_child(&self) {
        *self.child.lock().unwrap() = None;
        self.spawned_by_us.store(false, Ordering::SeqCst);
        self.release_app_lock();
    }

    /// Spawn the server from the configured checkout. Err carries a
    /// human-readable reason for the recovery screen.
    fn spawn(&self) -> Result<u32, String> {
        if !self.config.is_local() {
            return Err("remote hub mode never starts a local server".to_string());
        }
        match config::check_repo(&self.config) {
            RepoCheck::Invalid(reason) => return Err(reason),
            RepoCheck::Warning(warning) => log::warn!("Jarvis: {warning}"),
            RepoCheck::Ok => {}
        }
        let bun = config::resolve_bun(&self.config)?;
        let args = config::server_args(&self.config);
        let mut cmd = Command::new(&bun);
        cmd.args(&args)
            .current_dir(&self.config.repo_root)
            .env("BROWSER", "none")
            .env("PATH", path_with(&bun))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.config.env {
            cmd.env(key, value);
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        // Claim ownership before the child exists, so the PowerShell supervisor never sees a gap.
        self.hold_app_lock();
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                self.release_app_lock();
                return Err(format!("couldn't start {}: {err}", bun.display()));
            }
        };
        let pid = child.id();
        let line = format!(
            "spawned pid {pid}: {} {} (cwd {})",
            bun.display(),
            args.join(" "),
            self.config.repo_root.display()
        );
        log::info!("Jarvis: {line}");
        server_log::event(&self.log, &line);
        if let Some(out) = child.stdout.take() {
            server_log::pump(self.log.clone(), out, "out");
        }
        if let Some(err) = child.stderr.take() {
            server_log::pump(self.log.clone(), err, "err");
        }
        *self.child.lock().unwrap() = Some(child);
        self.spawned_by_us.store(true, Ordering::SeqCst);
        Ok(pid)
    }

    /// The supervision loop. Runs for the lifetime of the app.
    pub fn run(&self, ui: &dyn Ui) {
        let origin = self.config.origin();
        let port = self.config.port;
        let mut budget = RestartBudget::new(MAX_RESTARTS + 1, RESTART_WINDOW);
        let started = Instant::now();
        let mut showing_app = false;
        let mut shown_status: Option<Status> = None;
        let mut last_app_url: Option<String> = None;
        let mut down_since: Option<Instant> = None;
        let mut spawned_at: Option<Instant> = None;
        let mut next_spawn_at: Option<Instant> = None;
        let mut nav_failures: u32 = 0;
        let mut nav_retry_at: Option<Instant> = None;
        let timings = self.config.timings.clone();
        let mut version = VersionWatch::new(timings.version_refresh);
        let mut ever_attached = false;
        let mut waiting_on_other_logged = false;
        let mut last_error: Option<String> = None;

        let mut ever_up = false;
        match startup_action(self.port_open(), self.other_supervisor_alive()) {
            StartupAction::Attach => {
                log::info!("Jarvis: port {port} already accepting connections — attaching, not spawning");
                ever_attached = true;
            }
            StartupAction::LeaveToSupervisor => {
                // Review T8 S-1: at logon both started a server with a 1 s margin. While the PowerShell
                // supervisor runs, starting is its job; we adopt only after its worst case.
                log::info!("Jarvis: port {port} closed and the Agentic OS supervisor is running; leaving the start to it");
                ever_attached = true;
            }
            StartupAction::Spawn => next_spawn_at = Some(Instant::now()),
        }

        loop {
            let now = Instant::now();

            if self.manual_restart.swap(false, Ordering::SeqCst) {
                budget.reset();
                last_error = None;
                spawned_at = None;
                next_spawn_at = Some(now);
                server_log::event(&self.log, "manual restart requested from the tray");
            }

            if self.token_ok() {
                ever_up = true;
                down_since = None;
                last_error = None;
                waiting_on_other_logged = false;
                if self.spawned_by_us() && spawned_at.map_or(false, |t| now.duration_since(t) >= timings.stable_after) {
                    budget.reset();
                    spawned_at = None;
                }
                if version.due(now) {
                    if let Some(changed) = version.observe(now, self.fetch_version()) {
                        ui.set_version(&changed);
                    }
                }
                match self.nav_event.swap(0, Ordering::SeqCst) {
                    -1 => nav_failures = 0,
                    code if code > 0 && showing_app => {
                        nav_failures += 1;
                        let delay = Duration::from_secs((1u64 << nav_failures.min(5)).min(30));
                        let status = Status::new(
                            Phase::Recovering,
                            "Reloading Jarvis\u{2026}",
                            format!(
                                "The page didn't load (WebView2 error {}). Trying again in {}s.",
                                code - 1,
                                delay.as_secs()
                            ),
                        );
                        log::warn!("Jarvis: navigation failed (status {}), retry {nav_failures} in {delay:?}", code - 1);
                        ui.show_status_page(&status);
                        shown_status = Some(status);
                        showing_app = false;
                        nav_retry_at = Some(now + delay);
                    }
                    _ => {}
                }
                if !showing_app && nav_retry_at.map_or(true, |t| now >= t) {
                    let target = last_app_url.clone().unwrap_or_else(|| origin.clone());
                    log::info!("Jarvis: server ready, showing {target}");
                    ui.show_app(&target);
                    showing_app = true;
                    shown_status = None;
                    nav_retry_at = None;
                }
                std::thread::sleep(Duration::from_secs(if showing_app { 2 } else { 1 }));
                continue;
            }

            // Not answering.
            let down_for = now.duration_since(*down_since.get_or_insert(now));
            let threshold = if self.port_open() { SHOW_RECOVERY_AFTER_BUSY } else { SHOW_RECOVERY_AFTER };
            if showing_app && down_for >= threshold {
                if let Some(url) = ui.current_url().filter(|u| is_app_url(u, port)) {
                    last_app_url = Some(url);
                }
                showing_app = false;
                version.reset();
                shown_status = None;
                log::warn!("Jarvis: server stopped answering; showing the recovery screen");
            }

            let mut status = match self.child_state() {
                ChildState::Exited(code) => {
                    let code_text = code.map_or("no exit code".to_string(), |c| format!("exit code {c}"));
                    let line = format!("server exited ({code_text})");
                    log::warn!("Jarvis: {line}");
                    server_log::event(&self.log, &line);
                    self.forget_child();
                    spawned_at = None;
                    last_error = Some(format!("The OS server stopped ({code_text})."));
                    next_spawn_at = Some(now + budget.backoff(now));
                    Status::new(Phase::Recovering, "Recovering Jarvis\u{2026}", "")
                }
                ChildState::Running => {
                    let since_spawn = spawned_at.map(|t| now.duration_since(t));
                    let hung_for = hang_clock(since_spawn, down_for);
                    if hung_for >= timings.boot_timeout && !self.port_open() {
                        let line = format!("server hasn't had port {port} open for {}s; killing it", hung_for.as_secs());
                        log::warn!("Jarvis: {line}");
                        server_log::event(&self.log, &line);
                        self.kill_our_tree();
                        spawned_at = None;
                        last_error = Some(format!("The OS server hung for {}s without opening its port.", hung_for.as_secs()));
                        next_spawn_at = Some(now + budget.backoff(now));
                        Status::new(Phase::Recovering, "Recovering Jarvis\u{2026}", "")
                    } else if let Some(booting_for) = since_spawn {
                        Status::new(
                            Phase::Starting,
                            "Starting Jarvis\u{2026}",
                            format!("Starting the OS server on 127.0.0.1:{port} ({}s).", booting_for.as_secs()),
                        )
                    } else {
                        Status::new(
                            Phase::Recovering,
                            "Recovering Jarvis\u{2026}",
                            format!("The OS server stopped answering on 127.0.0.1:{port} ({}s).", down_for.as_secs()),
                        )
                    }
                }
                ChildState::None => {
                    if self.port_open() {
                        Status::new(
                            Phase::Starting,
                            "Starting Jarvis\u{2026}",
                            format!(
                                "Waiting for the server on 127.0.0.1:{port} to answer ({}s).",
                                down_for.as_secs()
                            ),
                        )
                    } else {
                        let other = ever_attached && next_spawn_at.is_none() && self.other_supervisor_alive();
                        let grace = adopt_grace(ever_attached, other, &timings);
                        if next_spawn_at.is_none() && down_for >= grace {
                            if other {
                                let line = format!(
                                    "the other supervisor hasn't brought port {port} back in {}s; starting the server here",
                                    down_for.as_secs()
                                );
                                log::warn!("Jarvis: {line}");
                                server_log::event(&self.log, &line);
                            }
                            next_spawn_at = Some(now);
                        }
                        if other && next_spawn_at.is_none() {
                            if !waiting_on_other_logged {
                                log::info!(
                                    "Jarvis: port {port} closed; the Agentic OS supervisor is running, so leaving the {} to it for up to {}s",
                                    if ever_up { "restart" } else { "start" },
                                    grace.as_secs()
                                );
                                waiting_on_other_logged = true;
                            }
                            Status::new(
                                Phase::Recovering,
                                "Recovering Jarvis\u{2026}",
                                format!(
                                    "The Agentic OS supervisor is {} the server on 127.0.0.1:{port} ({}s). \
                                     If it isn't up within {}s, Jarvis starts it itself.",
                                    if ever_up { "restarting" } else { "starting" },
                                    down_for.as_secs(),
                                    grace.as_secs()
                                ),
                            )
                        } else {
                            Status::new(
                                Phase::Recovering,
                                "Recovering Jarvis\u{2026}",
                                format!("Nothing is answering on 127.0.0.1:{port} ({}s).", down_for.as_secs()),
                            )
                        }
                    }
                }
            };

            if let Some(at) = next_spawn_at {
                let wait = budget.wait_time(now);
                if self.port_open() && !self.spawned_by_us() {
                    // Someone else (the PowerShell supervisor) got there first.
                    next_spawn_at = None;
                    ever_attached = true;
                } else if wait > Duration::ZERO {
                    // Budget spent: stay "stopped" (never "restarting in 454s") until the
                    // window slides or the owner uses the tray's Restart.
                    next_spawn_at = Some(now + wait);
                    status = Status::new(
                        Phase::Stopped,
                        "Jarvis stopped restarting the OS server",
                        format!(
                            "{} It was restarted {MAX_RESTARTS} times in {} minutes, so the app paused. \
                             Next try in about {} min, or use the tray's \u{201c}Restart OS server\u{201d} now. \
                             Server output: {}",
                            last_error.clone().unwrap_or_default(),
                            RESTART_WINDOW.as_secs() / 60,
                            wait.as_secs().div_ceil(60),
                            self.server_log_path()
                        )
                        .trim()
                        .to_string(),
                    );
                } else if now >= at {
                    budget.take(now);
                    next_spawn_at = None;
                    match self.spawn() {
                        Ok(pid) => {
                            spawned_at = Some(now);
                            status = Status::new(
                                Phase::Starting,
                                "Starting Jarvis\u{2026}",
                                format!("Started the OS server (pid {pid}) on 127.0.0.1:{port}."),
                            );
                        }
                        Err(reason) => {
                            log::error!("Jarvis: couldn't start the server: {reason}");
                            server_log::event(&self.log, &format!("couldn't start: {reason}"));
                            last_error = Some(format!("Couldn't start the OS server: {reason}."));
                            next_spawn_at = Some(now + budget.backoff(now));
                        }
                    }
                } else {
                    status = Status::new(
                        Phase::Recovering,
                        "Recovering Jarvis\u{2026}",
                        format!(
                            "{} Restarting in {}s (restart {} of {MAX_RESTARTS}).",
                            last_error.clone().unwrap_or_default(),
                            at.duration_since(now).as_secs().max(1),
                            budget.used(now).clamp(1, MAX_RESTARTS)
                        )
                        .trim()
                        .to_string(),
                    );
                }
            }
            if status.detail.is_empty() {
                status.detail = last_error.clone().unwrap_or_default();
            }
            if started.elapsed() < Duration::from_secs(2) && status.phase == Phase::Recovering && !ever_attached {
                status.phase = Phase::Starting;
            }

            match &shown_status {
                None if !showing_app => ui.show_status_page(&status),
                Some(prev) if *prev != status && !showing_app => ui.update_status(&status),
                _ => {}
            }
            if !showing_app {
                shown_status = Some(status);
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}

pub fn is_app_url(url: &str, port: u16) -> bool {
    let lower = url.to_ascii_lowercase();
    [format!("http://localhost:{port}"), format!("http://127.0.0.1:{port}")]
        .iter()
        .any(|o| lower == *o || lower.starts_with(&format!("{o}/")) || lower.starts_with(&format!("{o}?")))
}

fn parse_version(body: &str) -> Option<ServerVersion> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    Some(ServerVersion {
        version: value.get("version")?.as_str()?.to_string(),
        git_sha: value.get("gitSha")?.as_str()?.to_string(),
        dirty: value.get("dirty").and_then(|d| d.as_bool()).unwrap_or(false),
    })
}

/// PATH with bun.exe's own folder first, so nested `bun` calls inside the
/// package scripts resolve to the real exe too.
fn path_with(bun: &Path) -> std::ffi::OsString {
    let mut dirs: Vec<std::path::PathBuf> = bun.parent().map(|p| vec![p.to_path_buf()]).unwrap_or_default();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// What the app does when it starts, before its first health check.
#[derive(Debug, PartialEq, Eq)]
pub enum StartupAction {
    /// Something is already on the port.
    Attach,
    /// Nothing is, but the PowerShell supervisor is running: starting is its job.
    LeaveToSupervisor,
    /// Nothing is and nobody else will start it.
    Spawn,
}

pub fn startup_action(port_open: bool, other_supervisor_alive: bool) -> StartupAction {
    match (port_open, other_supervisor_alive) {
        (true, _) => StartupAction::Attach,
        (false, true) => StartupAction::LeaveToSupervisor,
        (false, false) => StartupAction::Spawn,
    }
}

/// Create (and hold) a named mutex; the raw handle value, or None if it couldn't be created.
#[cfg(windows)]
fn create_named_mutex(name: &str) -> Option<isize> {
    use windows::core::HSTRING;
    use windows::Win32::System::Threading::CreateMutexW;
    // SAFETY: a plain named-mutex create; the handle is kept until close_named_mutex.
    unsafe { CreateMutexW(None, false, &HSTRING::from(name)) }.ok().map(|h| h.0 as isize)
}

#[cfg(not(windows))]
fn create_named_mutex(_name: &str) -> Option<isize> {
    None
}

#[cfg(windows)]
fn close_named_mutex(handle: isize) {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    // SAFETY: the handle came from create_named_mutex and is closed exactly once.
    let _ = unsafe { CloseHandle(HANDLE(handle as *mut core::ffi::c_void)) };
}

#[cfg(not(windows))]
fn close_named_mutex(_handle: isize) {}

/// Does a named mutex exist right now? (Opening it doesn't take it.)
#[cfg(windows)]
pub fn named_mutex_exists(name: &str) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
    let wide = HSTRING::from(name);
    // SAFETY: a plain open by name; the handle is closed straight away.
    match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &wide) } {
        Ok(handle) => {
            let _ = unsafe { CloseHandle(handle) };
            true
        }
        Err(_) => false,
    }
}

#[cfg(not(windows))]
pub fn named_mutex_exists(_name: &str) -> bool {
    false
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.status();
}

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_is_bounded_and_slides() {
        let mut budget = RestartBudget::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(budget.take(t0));
        assert!(budget.take(t0 + Duration::from_secs(1)));
        assert!(budget.take(t0 + Duration::from_secs(2)));
        assert!(!budget.take(t0 + Duration::from_secs(3)), "fourth attempt inside the window is refused");
        assert_eq!(budget.wait_time(t0 + Duration::from_secs(3)), Duration::from_secs(57));
        assert!(budget.take(t0 + Duration::from_secs(61)), "the window slides");
        budget.reset();
        assert_eq!(budget.used(t0), 0);
    }

    #[test]
    fn backoff_grows_and_caps() {
        let mut budget = RestartBudget::new(10, Duration::from_secs(600));
        let t0 = Instant::now();
        assert_eq!(budget.backoff(t0), Duration::ZERO, "the first start is immediate");
        let mut seen = Vec::new();
        for i in 0..7 {
            budget.take(t0 + Duration::from_millis(i));
            seen.push(budget.backoff(t0 + Duration::from_millis(i)).as_secs());
        }
        assert_eq!(seen, vec![2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn version_label_marks_dirty_trees() {
        let v = parse_version(r#"{"version":"3.6.1","gitSha":"5eca7f0","dirty":true,"buildTime":"x"}"#).unwrap();
        assert_eq!(v.label("0.2.0"), "Jarvis v3.6.1 (5eca7f0-dirty) \u{b7} shell 0.2.0");
        let clean = parse_version(r#"{"version":"3.6.1","gitSha":"5eca7f0"}"#).unwrap();
        assert!(!clean.dirty);
        assert!(parse_version("<html>").is_none());
    }

    fn v(sha: &str) -> ServerVersion {
        ServerVersion { version: "3.6.1".into(), git_sha: sha.into(), dirty: true }
    }

    #[test]
    fn the_title_follows_a_version_that_changes_without_a_restart() {
        let t0 = Instant::now();
        let mut watch = VersionWatch::new(Duration::from_secs(30));
        assert!(watch.due(t0));
        assert_eq!(watch.observe(t0, Some(v("43ec3c8"))), Some(v("43ec3c8")), "first answer sets the title");
        assert!(!watch.due(t0 + Duration::from_secs(29)));
        assert!(watch.due(t0 + Duration::from_secs(30)));
        assert_eq!(watch.observe(t0 + Duration::from_secs(30), Some(v("43ec3c8"))), None, "same identity: no title churn");
        assert_eq!(watch.observe(t0 + Duration::from_secs(60), None), None, "a failed read changes nothing");
        assert!(!watch.due(t0 + Duration::from_secs(61)), "and waits a full interval before retrying");
        assert_eq!(
            watch.observe(t0 + Duration::from_secs(90), Some(v("f334ab7"))),
            Some(v("f334ab7")),
            "a fast-forwarded checkout reaches the title"
        );
        watch.reset();
        assert!(watch.due(t0 + Duration::from_secs(91)), "after a restart it reads at once");
        assert_eq!(watch.observe(t0 + Duration::from_secs(91), Some(v("f334ab7"))), Some(v("f334ab7")), "and re-announces");
    }

    #[test]
    fn a_live_powershell_supervisor_gets_time_to_restart_its_server() {
        let t = SupervisorTimings::default();
        assert_eq!(adopt_grace(false, true, &t), Duration::ZERO, "never attached: nothing to wait for");
        assert_eq!(adopt_grace(true, false, &t), Duration::from_secs(20));
        let with_ps = adopt_grace(true, true, &t);
        // It polls every 60 s and waits up to 90 s for boot; a shorter grace races it (28 Sep: 4 s apart).
        assert!(with_ps >= Duration::from_secs(150), "{with_ps:?} must cover the PowerShell supervisor's worst case");
    }

    #[test]
    fn a_server_that_hangs_after_a_healthy_spell_is_still_timed() {
        assert_eq!(hang_clock(Some(Duration::from_secs(12)), Duration::from_secs(3)), Duration::from_secs(12), "booting: from the spawn");
        assert_eq!(hang_clock(None, Duration::from_secs(200)), Duration::from_secs(200), "after the budget reset: from when it stopped answering");
        assert!(hang_clock(None, Duration::from_secs(200)) >= SupervisorTimings::default().boot_timeout);
    }

    #[cfg(windows)]
    #[test]
    fn a_held_named_mutex_is_seen_and_a_missing_one_is_not() {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::CreateMutexW;
        let name = format!("Local\\JarvisSupervisorTest-{}", std::process::id());
        assert!(!named_mutex_exists(&name));
        let handle = unsafe { CreateMutexW(None, true, &HSTRING::from(name.as_str())) }.unwrap();
        assert!(named_mutex_exists(&name));
        let _ = unsafe { CloseHandle(handle) };
        assert!(!named_mutex_exists(&name), "gone once its only holder closes it");
    }

    #[test]
    fn at_startup_the_app_leaves_the_first_start_to_a_running_powershell_supervisor() {
        assert_eq!(startup_action(true, true), StartupAction::Attach);
        assert_eq!(startup_action(true, false), StartupAction::Attach);
        assert_eq!(startup_action(false, true), StartupAction::LeaveToSupervisor);
        assert_eq!(startup_action(false, false), StartupAction::Spawn);
    }

    #[cfg(windows)]
    #[test]
    fn the_app_ownership_mutex_is_visible_while_held_and_gone_after() {
        let name = format!("Local\\JarvisAppServerTest-{}", std::process::id());
        assert!(!named_mutex_exists(&name));
        let handle = create_named_mutex(&name).expect("create");
        assert!(named_mutex_exists(&name), "the PowerShell supervisor can see it");
        close_named_mutex(handle);
        assert!(!named_mutex_exists(&name));
        assert_eq!(Supervisor::app_mutex_name(8081), "Local\\JarvisAppServer-8081");
    }

    #[test]
    fn app_urls_are_port_scoped() {
        assert!(is_app_url("http://localhost:8081/finance", 8081));
        assert!(is_app_url("http://127.0.0.1:8095/", 8095));
        assert!(!is_app_url("http://localhost:8081/finance", 8095));
        assert!(!is_app_url("http://localhost:80812/", 8081));
        assert!(!is_app_url("data:text/html,x", 8081));
    }
}
