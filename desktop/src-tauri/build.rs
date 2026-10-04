use std::path::Path;
use std::process::Command;

fn main() {
    // The shell's own build identity: the commit this binary was compiled from,
    // with "-dirty" when desktop/ had uncommitted changes. Diagnostic only —
    // the OS version shown in the window title comes from the *running*
    // server's /__version at runtime (lib.rs), not from the build machine.
    // Nothing else about the checkout is baked in: the repo to run is resolved
    // at runtime (config.rs), so an installed binary no longer points at
    // whichever worktree it happened to be built in.
    let manifest_dir = env!("CARGO_MANIFEST_DIR"); // .../desktop/src-tauri
    let desktop_dir = Path::new(manifest_dir).parent().expect("desktop/");
    println!("cargo:rustc-env=JARVIS_SHELL_BUILD={}", shell_build(desktop_dir));
    // tauri_build emits its own rerun-if-changed lines, which switches off
    // Cargo's "rerun on any package change" default, so without these the
    // SHA above went stale (an installed build reported a commit from hours
    // earlier). Rerun when our sources, HEAD or the index move.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=assets");
    println!("cargo:rerun-if-changed=build.rs");
    let branch_ref = git(desktop_dir, &["symbolic-ref", "-q", "HEAD"]).unwrap_or_default();
    for what in ["HEAD", "index", branch_ref.as_str()].into_iter().filter(|w| !w.is_empty()) {
        if let Some(path) = git(desktop_dir, &["rev-parse", "--path-format=absolute", "--git-path", what]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    tauri_build::build()
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|s| s.trim().to_string())
}

fn shell_build(desktop_dir: &Path) -> String {
    let Some(sha) = git(desktop_dir, &["rev-parse", "--short", "HEAD"]).filter(|s| !s.is_empty()) else {
        return "unknown".to_string();
    };
    let dirty = git(desktop_dir, &["status", "--porcelain", "--untracked-files=no", "--", "."])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if dirty {
        format!("{sha}-dirty")
    } else {
        sha
    }
}
