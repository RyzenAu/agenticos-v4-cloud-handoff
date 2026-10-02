//! Runtime configuration: which AgenticOS checkout to run, on which port,
//! with which `bun.exe`.
//!
//! Before 28 Sep 2026 the repo root was baked in at compile time from
//! `CARGO_MANIFEST_DIR`, so an installed binary built in a worktree
//! (`AgenticOS-v4-wt\w2-native`) tried to start *that* worktree's server
//! forever, and `bun` was spawned by bare name, which on this PC only
//! resolves to npm's `bun.cmd`/`bun.ps1` shims (`Command::new("bun")` ->
//! NotFound -> the app spun on "Recovering…" indefinitely).
//!
//! Resolution order (first hit wins, per field):
//! 1. environment: `JARVIS_REPO_ROOT`, `JARVIS_PORT`, `JARVIS_BUN`,
//!    `JARVIS_DESKTOP_CONFIG` (path of the JSON file below), `JARVIS_HUB_URL`;
//! 2. `%USERPROFILE%\.jarvis-desktop\config.json` (written by
//!    `scripts/windows/install-jarvis-desktop.ps1`). Deliberately under the
//!    profile root, not `%LOCALAPPDATA%`/`%APPDATA%`: new folders there are
//!    redirected into Claude desktop's MSIX package cache when created from
//!    an agent session, which is exactly how the first install went missing;
//! 3. defaults: `%USERPROFILE%\source\repos\AgenticOS-v4`, port 8081.
//!
//! `hubUrl` / `JARVIS_HUB_URL` switches the app into remote-hub mode (see
//! `HubMode`): it opens that hub and never starts a local server. Unset = local mode.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;

pub const DEFAULT_PORT: u16 = 8081;

/// The port the WebView2 handlers treat as "ours" (set once at startup).
static APP_PORT: AtomicU16 = AtomicU16::new(DEFAULT_PORT);

pub fn set_app_port(port: u16) {
    APP_PORT.store(port, Ordering::SeqCst);
}

pub fn app_port() -> u16 {
    APP_PORT.load(Ordering::SeqCst)
}
/// Which origin counts as "the app" for the WebView2 handlers (links, microphone,
/// navigation watch). Set once at startup from the config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppScope {
    /// Local mode: `localhost` / `127.0.0.1` on the app port.
    Local,
    /// Remote mode: only this hub origin.
    Hub(String),
    /// Invalid hub setting: no origin is ours (no mic grant, nothing stays in the window).
    Nothing,
}

static APP_SCOPE: Mutex<AppScope> = Mutex::new(AppScope::Local);

pub fn set_app_scope(scope: AppScope) {
    if let Ok(mut slot) = APP_SCOPE.lock() {
        *slot = scope;
    }
}

fn current_scope() -> AppScope {
    APP_SCOPE.lock().map(|s| s.clone()).unwrap_or(AppScope::Nothing)
}

/// Is `uri` inside the app's own origin (see `AppScope`)?
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_app_url(uri: &str) -> bool {
    is_app_url_in(uri, &current_scope(), app_port())
}

/// For logs: the origin `is_app_url` currently accepts.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn app_origin_label() -> String {
    match current_scope() {
        AppScope::Hub(origin) => origin,
        AppScope::Local => format!("http://localhost:{}", app_port()),
        AppScope::Nothing => "no origin (invalid hub setting)".to_string(),
    }
}

/// Pure form of `is_app_url`.
pub fn is_app_url_in(uri: &str, scope: &AppScope, port: u16) -> bool {
    match scope {
        AppScope::Hub(origin) => origin_matches(uri, origin),
        AppScope::Local => crate::supervisor::is_app_url(uri, port),
        AppScope::Nothing => false,
    }
}

/// `raw` with any `user:pw@` userinfo replaced, so a rejected URL can be shown or logged.
pub fn redact_userinfo(raw: &str) -> String {
    let (head, rest) = match raw.find("://") {
        Some(i) => raw.split_at(i + 3),
        None => ("", raw),
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..end].rfind('@') {
        Some(at) => format!("{head}<redacted>@{}", &rest[at + 1..]),
        None => raw.to_string(),
    }
}

/// `uri` is exactly `origin`, or a path/query/fragment under it. Not a longer
/// host (`https://x.ts.net.evil.com`) and not a longer port (`:80812`).
pub fn origin_matches(uri: &str, origin: &str) -> bool {
    let (lower, o) = (uri.to_ascii_lowercase(), origin.to_ascii_lowercase());
    lower == o || ["/", "?", "#"].iter().any(|sep| lower.starts_with(&format!("{o}{sep}")))
}

pub const EXPECTED_BRANCH: &str = "jarvis-voice";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfig {
    repo_root: Option<String>,
    port: Option<u16>,
    bun: Option<String>,
    /// Branch the checkout is expected to be on (default `jarvis-voice`).
    branch: Option<String>,
    /// Test/preview only: allow a linked worktree instead of the main checkout.
    #[serde(default)]
    allow_worktree: bool,
    /// Extra environment for the spawned server (e.g. `AGENTIC_OS_NO_BACKGROUND`).
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Extra arguments appended to the vite command (e.g. `--configLoader native`).
    #[serde(default)]
    extra_args: Vec<String>,
    /// A second, test-only instance: no single-instance lock, no global shortcut.
    #[serde(default)]
    instance: Option<String>,
    /// Named mutex held by another supervisor of this port (the Startup PowerShell
    /// supervisor holds `Local\AgenticOSSupervisor` for 8081). "" = none. Default:
    /// that mutex on 8081, none on any other port.
    supervisor_mutex: Option<String>,
    /// Test-only: shorter supervision timers, so a test instance can exercise them.
    #[serde(default)]
    timings: FileTimings,
    /// Remote-hub mode: the hub to open instead of starting a local server.
    hub_url: Option<String>,
    /// Set by `read_file_config` when the file exists but can't be used (never from JSON).
    #[serde(skip)]
    load_error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileTimings {
    adopt_grace_secs: Option<u64>,
    external_grace_secs: Option<u64>,
    boot_timeout_secs: Option<u64>,
    stable_after_secs: Option<u64>,
    version_refresh_secs: Option<u64>,
}

/// The name of the mutex `scripts/windows/agentic-os-supervisor.ps1` holds while it runs.
pub const POWERSHELL_SUPERVISOR_MUTEX: &str = "Local\\AgenticOSSupervisor";

/// Supervision timers (see `supervisor.rs`). Defaults are the production values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisorTimings {
    /// An attached server died and no other supervisor is running: wait this long before starting one.
    pub adopt_grace: Duration,
    /// Same, while another supervisor (the PowerShell one) is alive. It polls every 60 s and then
    /// waits up to 90 s for the server to open its port, so anything shorter races it: on 28 Sep
    /// both started a server 4 s apart and the loser ran ~8.5 min before exiting.
    pub external_grace: Duration,
    /// A server we own whose port stays closed this long (from spawn, or from when it stopped
    /// answering after a healthy spell) is hung: killed and counted as a failed start.
    pub boot_timeout: Duration,
    /// A spawned server that has been healthy this long resets the restart budget.
    pub stable_after: Duration,
    /// How often `/__version` is re-read while the server is healthy, so the title follows a
    /// checkout that moved without a process restart (Vite reloads its config in place).
    pub version_refresh: Duration,
}

impl Default for SupervisorTimings {
    fn default() -> Self {
        Self {
            adopt_grace: Duration::from_secs(20),
            external_grace: Duration::from_secs(180),
            boot_timeout: Duration::from_secs(180),
            stable_after: Duration::from_secs(120),
            version_refresh: Duration::from_secs(30),
        }
    }
}

impl SupervisorTimings {
    fn from_file(file: &FileTimings) -> Self {
        let d = Self::default();
        let secs = |v: Option<u64>, default: Duration| v.map(Duration::from_secs).unwrap_or(default);
        Self {
            adopt_grace: secs(file.adopt_grace_secs, d.adopt_grace),
            external_grace: secs(file.external_grace_secs, d.external_grace),
            boot_timeout: secs(file.boot_timeout_secs, d.boot_timeout),
            stable_after: secs(file.stable_after_secs, d.stable_after),
            version_refresh: secs(file.version_refresh_secs, d.version_refresh),
        }
    }
}

/// A validated remote hub: `origin` is `scheme://host[:port]` with no path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hub {
    pub origin: String,
    pub host: String,
    pub port: u16,
}

/// Which hub the app shows, decided once from the settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubMode {
    /// No hub URL: supervise a local `bun` server (the original behaviour).
    Local,
    /// Open this hub; never start, supervise, restart or lock anything locally.
    Remote(Hub),
    /// A hub URL was given but is not allowed. Shown as an error; never falls back to local.
    Invalid(String),
}

/// Validate a hub URL: `https://<name>.ts.net[:port]` (Tailscale), or
/// `http://localhost` / `http://127.0.0.1` for tests. Origin only: no
/// credentials, path, query or fragment.
pub fn parse_hub_url(raw: &str) -> Result<Hub, String> {
    let raw = raw.trim();
    let shown = redact_userinfo(raw);
    let bad = |why: &str| {
        Err(format!(
            "hubUrl \"{shown}\" is not allowed: {why}. Use https://<machine>.<tailnet>.ts.net[:port] \
             (or http://localhost / http://127.0.0.1 for tests)."
        ))
    };
    let url = match tauri::Url::parse(raw) {
        Ok(url) => url,
        Err(err) => return bad(&format!("not a URL ({err})")), // url's message never echoes the input
    };
    if !url.username().is_empty() || url.password().is_some() {
        return bad("it must not contain credentials");
    }
    if url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
        return bad("give the hub's address only, with no path, query or fragment");
    }
    let host = match url.host_str() {
        Some(h) if !h.is_empty() && !h.starts_with('[') => h.to_ascii_lowercase(),
        _ => return bad("the host must be a name"),
    };
    let allowed = match url.scheme() {
        "https" => host.len() > ".ts.net".len() && host.ends_with(".ts.net"),
        "http" => host == "localhost" || host == "127.0.0.1",
        _ => false,
    };
    if !allowed {
        return bad(match url.scheme() {
            "https" => "the host must end in .ts.net",
            "http" => "plain http is only allowed for localhost / 127.0.0.1",
            _ => "only https:// is allowed",
        });
    }
    let port = url.port_or_known_default().unwrap_or(443);
    Ok(Hub { origin: url.origin().ascii_serialization(), host, port })
}

#[derive(Debug, Clone)]
pub struct DesktopConfig {
    pub repo_root: PathBuf,
    pub port: u16,
    pub bun_override: Option<PathBuf>,
    pub branch: String,
    pub allow_worktree: bool,
    pub env: BTreeMap<String, String>,
    pub extra_args: Vec<String>,
    /// `Some("test")` for a side-by-side test instance.
    pub instance: Option<String>,
    /// Another supervisor's named mutex for this port (see `FileConfig::supervisor_mutex`).
    pub supervisor_mutex: Option<String>,
    pub timings: SupervisorTimings,
    pub hub: HubMode,
    /// Where the settings came from, for the log and the recovery screen.
    pub source: String,
    pub config_path: PathBuf,
}

impl DesktopConfig {
    pub fn origin(&self) -> String {
        match &self.hub {
            HubMode::Remote(hub) => hub.origin.clone(),
            _ => format!("http://localhost:{}", self.port),
        }
    }

    /// True only in local mode: the app owns (or attaches to) a server on this PC.
    pub fn app_scope(&self) -> AppScope {
        match &self.hub {
            HubMode::Local => AppScope::Local,
            HubMode::Remote(hub) => AppScope::Hub(hub.origin.clone()),
            HubMode::Invalid(_) => AppScope::Nothing,
        }
    }

    pub fn is_local(&self) -> bool {
        self.hub == HubMode::Local
    }

    pub fn remote_hub(&self) -> Option<&Hub> {
        match &self.hub {
            HubMode::Remote(hub) => Some(hub),
            _ => None,
        }
    }

    /// 127.0.0.1, not `localhost`: resolving the literal hostname from a
    /// plain Rust HTTP client took ~5s on this PC (WebView2 fast-paths it).
    pub fn loopback_base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn is_test_instance(&self) -> bool {
        self.instance.is_some()
    }
}

fn profile_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn default_config_path() -> PathBuf {
    profile_dir().join(".jarvis-desktop").join("config.json")
}

pub fn load() -> DesktopConfig {
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let config_path = env("JARVIS_DESKTOP_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(default_config_path);
    let (file, file_note) = read_file_config(&config_path);
    resolve(file, file_note, config_path, env)
}

/// Reads the config file. Missing = defaults (local mode). Present but unreadable or unparseable =
/// `load_error` is set: the hub setting is then `Invalid`, never a silent fall back to a local hub
/// (a PC meant to be remote-only must not start bun because of a typo). Only the error *class* and
/// position are kept: serde's message can quote the offending value.
fn read_file_config(config_path: &Path) -> (FileConfig, String) {
    let broken = |what: String| {
        log::error!("Jarvis: {what}");
        (
            FileConfig { load_error: Some(what.clone()), ..Default::default() },
            format!("defaults ({what})"),
        )
    };
    match fs::read_to_string(config_path) {
        Ok(text) => match serde_json::from_str::<FileConfig>(text.trim_start_matches('\u{feff}')) {
            Ok(parsed) => (parsed, config_path.display().to_string()),
            Err(err) => broken(format!(
                "{} can't be parsed ({:?} error at line {} column {})",
                config_path.display(),
                err.classify(),
                err.line(),
                err.column()
            )),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            (FileConfig::default(), "defaults (no config file)".to_string())
        }
        Err(err) => broken(format!("{} can't be read ({:?})", config_path.display(), err.kind())),
    }
}

fn resolve(
    file: FileConfig,
    file_note: String,
    config_path: PathBuf,
    env: impl Fn(&str) -> Option<String>,
) -> DesktopConfig {
    let mut source = file_note;
    let repo_root = match env("JARVIS_REPO_ROOT") {
        Some(root) => {
            source = format!("JARVIS_REPO_ROOT + {source}");
            PathBuf::from(root)
        }
        None => file
            .repo_root
            .map(PathBuf::from)
            .unwrap_or_else(|| profile_dir().join("source").join("repos").join("AgenticOS-v4")),
    };
    let port = env("JARVIS_PORT")
        .and_then(|p| p.parse().ok())
        .or(file.port)
        .unwrap_or(DEFAULT_PORT);
    let supervisor_mutex = match file.supervisor_mutex {
        Some(name) if name.trim().is_empty() => None,
        Some(name) => Some(name),
        None if port == DEFAULT_PORT => Some(POWERSHELL_SUPERVISOR_MUTEX.to_string()),
        None => None,
    };
    let timings = SupervisorTimings::from_file(&file.timings);
    // Env beats file. A set-but-invalid value is an error, never a quiet fallback to local mode
    // (and an invalid env value does not fall through to the file either).
    let hub_raw = match env("JARVIS_HUB_URL") {
        Some(raw) => {
            source = format!("JARVIS_HUB_URL + {source}");
            Some(raw)
        }
        None => file.hub_url.filter(|v| !v.trim().is_empty()),
    };
    let hub = match (hub_raw, &file.load_error) {
        (Some(raw), _) => match parse_hub_url(&raw) {
            Ok(hub) => HubMode::Remote(hub),
            Err(err) => HubMode::Invalid(err),
        },
        (None, Some(why)) => HubMode::Invalid(format!(
            "The settings file is unusable, so Jarvis can't tell whether a hub was intended: {why}."
        )),
        (None, None) => HubMode::Local,
    };
    let supervisor_mutex = if hub == HubMode::Local { supervisor_mutex } else { None };
    DesktopConfig {
        hub,
        repo_root,
        port,
        supervisor_mutex,
        timings,
        bun_override: env("JARVIS_BUN").or(file.bun).map(PathBuf::from),
        branch: file.branch.unwrap_or_else(|| EXPECTED_BRANCH.to_string()),
        allow_worktree: file.allow_worktree,
        env: file.env,
        extra_args: file.extra_args,
        instance: env("JARVIS_INSTANCE").or(file.instance),
        source,
        config_path,
    }
}

/// Outcome of checking that `repo_root` really is the AgenticOS checkout.
#[derive(Debug, PartialEq)]
pub enum RepoCheck {
    Ok,
    /// Usable, but worth surfacing (e.g. on another branch).
    Warning(String),
    /// Refuse to spawn from here.
    Invalid(String),
}

/// Sanity check: the canonical AgenticOS checkout (a main checkout with its
/// own `.git` directory, not a linked worktree), with the files `bun run start`
/// needs, on the expected branch (a different branch is a warning, not a stop:
/// the owner may switch branches deliberately).
pub fn check_repo(config: &DesktopConfig) -> RepoCheck {
    let root = &config.repo_root;
    if !root.is_dir() {
        return RepoCheck::Invalid(format!("{} does not exist", root.display()));
    }
    for needed in ["package.json", "vite.config.ts"] {
        if !root.join(needed).is_file() {
            return RepoCheck::Invalid(format!(
                "{} has no {needed}, so it isn't the AgenticOS checkout",
                root.display()
            ));
        }
    }
    let package = fs::read_to_string(root.join("package.json")).unwrap_or_default();
    if !package.contains("\"start\"") {
        return RepoCheck::Invalid(format!("{}\\package.json has no \"start\" script", root.display()));
    }
    let git = root.join(".git");
    if git.is_file() && !config.allow_worktree {
        return RepoCheck::Invalid(format!(
            "{} is a linked git worktree, not the main AgenticOS checkout (set repoRoot in {})",
            root.display(),
            config.config_path.display()
        ));
    }
    let head = if git.is_dir() {
        fs::read_to_string(git.join("HEAD")).ok()
    } else {
        worktree_head(&git)
    };
    match head.as_deref().map(str::trim) {
        Some(h) if h == format!("ref: refs/heads/{}", config.branch) => RepoCheck::Ok,
        Some(h) => RepoCheck::Warning(format!(
            "{} is on `{}`, not `{}`",
            root.display(),
            h.trim_start_matches("ref: refs/heads/"),
            config.branch
        )),
        None => RepoCheck::Invalid(format!("{} is not a git checkout", root.display())),
    }
}

fn worktree_head(git_file: &Path) -> Option<String> {
    let text = fs::read_to_string(git_file).ok()?;
    let gitdir = text.trim().strip_prefix("gitdir:")?.trim();
    fs::read_to_string(Path::new(gitdir).join("HEAD")).ok()
}

/// The real `bun.exe`. Never a `.cmd`/`.ps1` shim: `CreateProcess` can't run
/// those directly, and routing through `cmd.exe` adds an 8 KB command-line cap
/// and a console window. Mirrors `scripts/windows/agentic-os-supervisor.ps1`.
pub fn resolve_bun(config: &DesktopConfig) -> Result<PathBuf, String> {
    let mut tried = Vec::new();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = &config.bun_override {
        candidates.push(explicit.clone());
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        candidates.push(PathBuf::from(appdata).join("npm").join("node_modules").join("bun").join("bin").join("bun.exe"));
    }
    candidates.push(profile_dir().join(".bun").join("bin").join("bun.exe"));
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("bun.exe"));
        }
    }
    for (i, candidate) in candidates.into_iter().enumerate() {
        if is_real_exe(&candidate) {
            return Ok(candidate);
        }
        if i == 0 && config.bun_override.is_some() {
            // Said out loud: an explicit JARVIS_BUN / "bun" that isn't a real bun.exe used to
            // fall through to the next candidate silently.
            log::warn!("Jarvis: ignoring the configured bun {}: {}", candidate.display(), bun_rejection(&candidate));
        }
        tried.push(candidate.display().to_string());
    }
    Err(format!(
        "no bun.exe found (tried {}). Install Bun or set \"bun\" in {}",
        tried.iter().take(4).cloned().collect::<Vec<_>>().join(", "),
        config.config_path.display()
    ))
}

/// Why a configured bun path isn't used (for the log).
pub fn bun_rejection(path: &Path) -> &'static str {
    if !path.exists() {
        "it doesn't exist"
    } else if !path.is_file() {
        "it isn't a file"
    } else {
        "it isn't a real .exe (a .cmd/.ps1 shim can't be started directly)"
    }
}

fn is_real_exe(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("exe"))
            .unwrap_or(false)
}

/// Arguments for the server. On the canonical port this is exactly what the
/// PowerShell supervisor runs (`bun --bun run start`, which pins 8081 with
/// `--strictPort`); on any other port (a test instance) it runs the same
/// `dev` script with that port, still strict so a collision fails loudly.
pub fn server_args(config: &DesktopConfig) -> Vec<String> {
    let mut args: Vec<String> = if config.port == DEFAULT_PORT {
        vec!["--bun".into(), "run".into(), "start".into()]
    } else {
        vec![
            "--bun".into(),
            "run".into(),
            "dev".into(),
            "--port".into(),
            config.port.to_string(),
            "--strictPort".into(),
        ]
    };
    args.extend(config.extra_args.iter().cloned());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jarvis-config-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn config_for(root: &Path) -> DesktopConfig {
        resolve(
            FileConfig { repo_root: Some(root.display().to_string()), ..Default::default() },
            "test".into(),
            root.join("config.json"),
            |_| None,
        )
    }

    fn fake_repo(root: &Path, head: &str) {
        fs::write(root.join("package.json"), r#"{"scripts":{"start":"x"}}"#).unwrap();
        fs::write(root.join("vite.config.ts"), "").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("HEAD"), head).unwrap();
    }

    #[test]
    fn env_beats_file_beats_default() {
        let file = FileConfig { repo_root: Some("C:\\from-file".into()), port: Some(8095), ..Default::default() };
        let cfg = resolve(file, "f".into(), PathBuf::from("c.json"), |name| match name {
            "JARVIS_REPO_ROOT" => Some("C:\\from-env".into()),
            _ => None,
        });
        assert_eq!(cfg.repo_root, PathBuf::from("C:\\from-env"));
        assert_eq!(cfg.port, 8095);
        assert_eq!(cfg.branch, "jarvis-voice");
        let cfg = resolve(FileConfig::default(), "d".into(), PathBuf::from("c.json"), |_| None);
        assert!(cfg.repo_root.ends_with("source\\repos\\AgenticOS-v4") || cfg.repo_root.ends_with("source/repos/AgenticOS-v4"));
        assert_eq!(cfg.port, DEFAULT_PORT);
        assert!(!cfg.is_test_instance());
    }

    #[test]
    fn main_checkout_on_jarvis_voice_is_ok() {
        let root = temp_dir("ok");
        fake_repo(&root, "ref: refs/heads/jarvis-voice\n");
        assert_eq!(check_repo(&config_for(&root)), RepoCheck::Ok);
    }

    #[test]
    fn other_branch_is_a_warning_not_a_stop() {
        let root = temp_dir("branch");
        fake_repo(&root, "ref: refs/heads/main\n");
        assert!(matches!(check_repo(&config_for(&root)), RepoCheck::Warning(_)));
    }

    #[test]
    fn a_linked_worktree_is_refused_unless_allowed() {
        let root = temp_dir("wt");
        fs::write(root.join("package.json"), r#"{"scripts":{"start":"x"}}"#).unwrap();
        fs::write(root.join("vite.config.ts"), "").unwrap();
        let gitdir = root.join("gitdir");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/f/x\n").unwrap();
        fs::write(root.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        let mut cfg = config_for(&root);
        assert!(matches!(check_repo(&cfg), RepoCheck::Invalid(msg) if msg.contains("worktree")));
        cfg.allow_worktree = true;
        assert!(matches!(check_repo(&cfg), RepoCheck::Warning(_)));
    }

    #[test]
    fn a_folder_without_the_app_is_refused() {
        let root = temp_dir("empty");
        assert!(matches!(check_repo(&config_for(&root)), RepoCheck::Invalid(_)));
        assert!(matches!(
            check_repo(&config_for(&root.join("missing"))),
            RepoCheck::Invalid(msg) if msg.contains("does not exist")
        ));
    }

    #[test]
    fn bun_is_only_ever_a_real_exe() {
        let root = temp_dir("bun");
        let shim = root.join("bun.cmd");
        fs::write(&shim, "@echo off").unwrap();
        assert!(!is_real_exe(&shim));
        let exe = root.join("bun.exe");
        fs::write(&exe, "MZ").unwrap();
        assert!(is_real_exe(&exe));
        let mut cfg = config_for(&root);
        cfg.bun_override = Some(exe.clone());
        assert_eq!(resolve_bun(&cfg).unwrap(), exe);
    }

    #[test]
    fn the_powershell_supervisor_mutex_applies_to_8081_only_unless_configured() {
        let cfg = resolve(FileConfig::default(), "d".into(), PathBuf::from("c.json"), |_| None);
        assert_eq!(cfg.supervisor_mutex.as_deref(), Some("Local\\AgenticOSSupervisor"));
        assert_eq!(cfg.timings, SupervisorTimings::default());
        let file = FileConfig { port: Some(8131), ..Default::default() };
        assert_eq!(resolve(file, "f".into(), PathBuf::from("c.json"), |_| None).supervisor_mutex, None);
        let file = FileConfig { port: Some(8131), supervisor_mutex: Some("Local\\T8Test".into()), ..Default::default() };
        assert_eq!(resolve(file, "f".into(), PathBuf::from("c.json"), |_| None).supervisor_mutex.as_deref(), Some("Local\\T8Test"));
        let file = FileConfig { supervisor_mutex: Some(" ".into()), ..Default::default() };
        assert_eq!(resolve(file, "f".into(), PathBuf::from("c.json"), |_| None).supervisor_mutex, None, "a blank name turns it off");
    }

    #[test]
    fn test_timings_override_only_what_they_name() {
        let file: FileConfig = serde_json::from_str(r#"{"timings":{"adoptGraceSecs":3,"bootTimeoutSecs":9}}"#).unwrap();
        let cfg = resolve(file, "f".into(), PathBuf::from("c.json"), |_| None);
        assert_eq!(cfg.timings.adopt_grace, Duration::from_secs(3));
        assert_eq!(cfg.timings.boot_timeout, Duration::from_secs(9));
        assert_eq!(cfg.timings.external_grace, SupervisorTimings::default().external_grace);
    }

    #[test]
    fn a_rejected_bun_override_says_why() {
        let root = temp_dir("bunwhy");
        assert_eq!(bun_rejection(&root.join("nope.exe")), "it doesn't exist");
        assert_eq!(bun_rejection(&root), "it isn't a file");
        let shim = root.join("bun.cmd");
        fs::write(&shim, "@echo off").unwrap();
        assert!(bun_rejection(&shim).contains("shim"));
    }

    #[test]
    fn canonical_port_runs_start_other_ports_run_dev_strictly() {
        let root = temp_dir("args");
        let mut cfg = config_for(&root);
        assert_eq!(server_args(&cfg), ["--bun", "run", "start"]);
        cfg.port = 8095;
        cfg.extra_args = vec!["--configLoader".into(), "native".into()];
        assert_eq!(
            server_args(&cfg),
            ["--bun", "run", "dev", "--port", "8095", "--strictPort", "--configLoader", "native"]
        );
    }

    fn hub_cfg(env_hub: Option<&str>, file_hub: Option<&str>) -> DesktopConfig {
        let file = FileConfig { hub_url: file_hub.map(str::to_string), ..Default::default() };
        resolve(file, "f".into(), PathBuf::from("c.json"), |name| match name {
            "JARVIS_HUB_URL" => env_hub.map(str::to_string),
            _ => None,
        })
    }

    #[test]
    fn no_hub_url_is_local_mode() {
        let cfg = hub_cfg(None, None);
        assert_eq!(cfg.hub, HubMode::Local);
        assert!(cfg.is_local());
        assert_eq!(cfg.origin(), "http://localhost:8081");
        assert_eq!(hub_cfg(None, Some("  ")).hub, HubMode::Local, "a blank file value is unset");
        assert_eq!(cfg.supervisor_mutex.as_deref(), Some("Local\\AgenticOSSupervisor"), "local mode unchanged");
    }

    #[test]
    fn hub_url_precedence_is_env_then_file_then_unset() {
        let file_only = hub_cfg(None, Some("https://file-pc.tail1.ts.net:8443"));
        assert_eq!(file_only.remote_hub().unwrap().origin, "https://file-pc.tail1.ts.net:8443");
        let both = hub_cfg(Some("https://env-pc.tail1.ts.net"), Some("https://file-pc.tail1.ts.net:8443"));
        assert_eq!(both.remote_hub().unwrap().origin, "https://env-pc.tail1.ts.net");
        assert_eq!(both.origin(), "https://env-pc.tail1.ts.net");
        assert!(both.source.contains("JARVIS_HUB_URL"));
        // A bad env value is an error, not a fall-through to a good file value or to local mode.
        let bad_env = hub_cfg(Some("https://evil.example"), Some("https://file-pc.tail1.ts.net"));
        assert!(matches!(bad_env.hub, HubMode::Invalid(_)));
        assert!(!bad_env.is_local());
        assert!(matches!(hub_cfg(None, Some("http://192.168.1.120:8081")).hub, HubMode::Invalid(_)));
    }

    #[test]
    fn hub_url_file_field_is_camel_case() {
        let file: FileConfig = serde_json::from_str(r#"{"hubUrl":"https://ryzen-pc.tail1.ts.net:8443"}"#).unwrap();
        let cfg = resolve(file, "f".into(), PathBuf::from("c.json"), |_| None);
        let hub = cfg.remote_hub().unwrap();
        assert_eq!((hub.host.as_str(), hub.port), ("ryzen-pc.tail1.ts.net", 8443));
        assert_eq!(cfg.supervisor_mutex, None, "remote mode has no local supervisor to wait for");
    }

    #[test]
    fn hub_url_validation_accepts_only_tailnet_https_and_local_http() {
        for ok in [
            "https://ryzen-pc.tail1234.ts.net:8443",
            "https://ryzen-pc.tail1234.ts.net",
            "https://ryzen-pc.tail1234.ts.net/",
            "HTTPS://Ryzen-PC.Tail1234.TS.NET:8443",
            "http://localhost",
            "http://localhost:8081",
            "http://127.0.0.1:8081",
        ] {
            assert!(parse_hub_url(ok).is_ok(), "{ok} should be accepted");
        }
        for bad in [
            "http://192.168.1.120:8081",
            "https://evil.example",
            "https://x.ts.net.evil.com",
            "https://evil.com/x.ts.net",
            "https://user:pw@x.tail1.ts.net",
            "https://x.tail1.ts.net@evil.com",
            "https://.ts.net",
            "https://ts.net",
            "http://x.tail1.ts.net:8443",
            "http://localhost.evil.com",
            "ftp://x.tail1.ts.net",
            "https://x.tail1.ts.net/hud",
            "https://x.tail1.ts.net/?a=1",
            "https://100.101.102.103:8443",
            "ryzen-pc",
            "",
        ] {
            assert!(parse_hub_url(bad).is_err(), "{bad} should be rejected");
        }
        let err = parse_hub_url("https://evil.example").unwrap_err();
        assert!(err.contains("https://evil.example") && err.contains(".ts.net"), "{err}");
        assert_eq!(
            parse_hub_url("HTTPS://Ryzen-PC.Tail1234.TS.NET:8443").unwrap().origin,
            "https://ryzen-pc.tail1234.ts.net:8443"
        );
    }

    #[test]
    fn origin_matching_is_exact_on_host_and_port() {
        let o = "https://ryzen-pc.tail1.ts.net:8443";
        assert!(origin_matches("https://ryzen-pc.tail1.ts.net:8443", o));
        assert!(origin_matches("https://ryzen-pc.tail1.ts.net:8443/leads?x=1", o));
        assert!(origin_matches("HTTPS://RYZEN-PC.tail1.ts.net:8443/#a", o));
        assert!(!origin_matches("https://ryzen-pc.tail1.ts.net:84430/", o));
        assert!(!origin_matches("https://ryzen-pc.tail1.ts.net:8443.evil.com/", o));
        assert!(!origin_matches("https://ryzen-pc.tail1.ts.net/", o), "different port");
        assert!(!origin_matches("http://ryzen-pc.tail1.ts.net:8443/", o), "different scheme");
        assert!(!origin_matches("https://evil.example/", o));
    }

    #[test]
    fn links_and_microphone_scope_follow_the_mode() {
        let hub = AppScope::Hub("https://ryzen-pc.tail1.ts.net:8443".into());
        // Remote: the hub origin, and nothing local.
        assert!(is_app_url_in("https://ryzen-pc.tail1.ts.net:8443/hud", &hub, 8081));
        assert!(!is_app_url_in("http://localhost:8081/", &hub, 8081), "local origin is not ours in remote mode");
        assert!(!is_app_url_in("http://127.0.0.1:8081/", &hub, 8081));
        assert!(!is_app_url_in("https://www.example.com/", &hub, 8081));
        assert!(!is_app_url_in("https://other.tail1.ts.net:8443/", &hub, 8081), "another tailnet machine is not the hub");
        // Local: unchanged.
        assert!(is_app_url_in("http://localhost:8081/x", &AppScope::Local, 8081));
        assert!(!is_app_url_in("https://ryzen-pc.tail1.ts.net:8443/", &AppScope::Local, 8081));
        // Invalid hub setting: nothing is the app's origin (no mic grant, nothing stays in the window).
        for uri in ["http://localhost:8081/", "http://127.0.0.1:8081/", "https://ryzen-pc.tail1.ts.net:8443/"] {
            assert!(!is_app_url_in(uri, &AppScope::Nothing, 8081), "{uri}");
        }
        assert_eq!(hub_cfg(None, None).app_scope(), AppScope::Local);
        assert_eq!(hub_cfg(Some("https://evil.example"), None).app_scope(), AppScope::Nothing);
        assert_eq!(
            hub_cfg(Some("https://h.tail1.ts.net"), None).app_scope(),
            AppScope::Hub("https://h.tail1.ts.net".into())
        );
    }

    #[test]
    fn rejected_urls_never_echo_credentials() {
        for raw in [
            "https://user:s3cret@evil.example",
            "https://x.tail1.ts.net@evil.com",
            "https://user:s3cret@x.tail1.ts.net/hud",
            "user:s3cret@host",
        ] {
            let err = parse_hub_url(raw).unwrap_err();
            assert!(!err.contains("s3cret") && !err.contains("user:"), "{raw} -> {err}");
        }
        assert_eq!(redact_userinfo("https://a:b@h.example/p@q"), "https://<redacted>@h.example/p@q");
        assert_eq!(redact_userinfo("https://h.example/p@q"), "https://h.example/p@q");
        assert!(parse_hub_url("https://x.tail1.ts.net@evil.com").unwrap_err().contains("<redacted>@evil.com"));
    }

    fn file_config_from_text(name: &str, text: &str) -> (FileConfig, String) {
        let dir = temp_dir(name);
        let path = dir.join("config.json");
        fs::write(&path, text).unwrap();
        let out = read_file_config(&path);
        let _ = fs::remove_dir_all(&dir);
        out
    }

    fn mode_for_file_text(name: &str, text: &str, env_hub: Option<&str>) -> HubMode {
        let (file, note) = file_config_from_text(name, text);
        resolve(file, note, PathBuf::from("c.json"), |n| match n {
            "JARVIS_HUB_URL" => env_hub.map(str::to_string),
            _ => None,
        })
        .hub
    }

    #[test]
    fn an_unusable_config_file_is_invalid_never_a_silent_local_hub() {
        for (i, text) in [
            r#"{"hubUrl":"https://ryzen-pc.tail1.ts.net:8443","port":"8443"}"#, // wrong type for another key
            r#"{"hubUrl":123}"#,
            r#"{"hubUrl":"https://ryzen-pc.tail1.ts.net:8443",}"#, // trailing comma
            r#"{"hubUrl":"https://ryzen-pc.tail1.ts.net:84"#,      // truncated
            "",
            "not json",
        ]
        .into_iter()
        .enumerate()
        {
            match mode_for_file_text(&format!("bad{i}"), text, None) {
                HubMode::Invalid(msg) => {
                    assert!(msg.contains("can't be parsed"), "{text}: {msg}");
                    assert!(msg.contains("config.json"), "names the file: {msg}");
                    assert!(msg.contains("error at line"), "names the error class: {msg}");
                    assert!(!msg.contains("8443"), "does not quote the file's values: {msg}");
                }
                other => panic!("{text:?} gave {other:?}, expected Invalid"),
            }
        }
    }

    #[test]
    fn a_valid_env_hub_still_wins_over_a_broken_file_and_a_missing_file_is_local() {
        let mode = mode_for_file_text("envwins", "{broken", Some("https://ryzen-pc.tail1.ts.net:8443"));
        assert!(matches!(mode, HubMode::Remote(_)), "{mode:?}");
        let mode = mode_for_file_text("envbad", "{broken", Some("https://evil.example"));
        assert!(matches!(mode, HubMode::Invalid(_)), "{mode:?}");
        let (file, note) = read_file_config(&temp_dir("missing").join("nope.json"));
        assert!(file.load_error.is_none() && note.contains("no config file"));
        assert_eq!(resolve(file, note, PathBuf::from("c.json"), |_| None).hub, HubMode::Local);
        // A good file is untouched by all of this; a BOM is tolerated.
        let mode = mode_for_file_text("good", "\u{feff}{\"hubUrl\":\"https://h.tail1.ts.net\"}", None);
        assert!(matches!(mode, HubMode::Remote(_)), "{mode:?}");
        assert_eq!(mode_for_file_text("goodlocal", r#"{"port":8081}"#, None), HubMode::Local);
    }
}
