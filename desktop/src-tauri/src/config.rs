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
//!    `JARVIS_DESKTOP_CONFIG` (path of the JSON file below);
//! 2. `%USERPROFILE%\.jarvis-desktop\config.json` (written by
//!    `scripts/windows/install-jarvis-desktop.ps1`). Deliberately under the
//!    profile root, not `%LOCALAPPDATA%`/`%APPDATA%`: new folders there are
//!    redirected into Claude desktop's MSIX package cache when created from
//!    an agent session, which is exactly how the first install went missing;
//! 3. defaults: `%USERPROFILE%\source\repos\AgenticOS-v4`, port 8081.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use std::sync::atomic::{AtomicU16, Ordering};
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
    /// Where the settings came from, for the log and the recovery screen.
    pub source: String,
    pub config_path: PathBuf,
}

impl DesktopConfig {
    pub fn origin(&self) -> String {
        format!("http://localhost:{}", self.port)
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
    let (file, file_note) = match fs::read_to_string(&config_path) {
        Ok(text) => match serde_json::from_str::<FileConfig>(text.trim_start_matches('\u{feff}')) {
            Ok(parsed) => (parsed, format!("{}", config_path.display())),
            Err(err) => {
                log::error!("Jarvis: ignoring unreadable {}: {err}", config_path.display());
                (FileConfig::default(), format!("defaults ({} is invalid: {err})", config_path.display()))
            }
        },
        Err(_) => (FileConfig::default(), "defaults (no config file)".to_string()),
    };
    resolve(file, file_note, config_path, env)
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
    DesktopConfig {
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
}
