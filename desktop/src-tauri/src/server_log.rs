//! Rotating file log for the Bun server this app spawns.
//!
//! Before 28 Sep 2026 the child's stdout/stderr went to `Stdio::null()`, so a
//! server that died during boot left no trace at all. Now both streams are
//! piped into `server.log` in the app's log folder, rotated at
//! `MAX_BYTES` into `server.log.1` … `server.log.{KEEP}`.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const KEEP: usize = 3;

pub struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: Option<File>,
    written: u64,
}

impl RotatingLog {
    pub fn new(path: PathBuf, max_bytes: u64, keep: usize) -> Self {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let written = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self { path, max_bytes, keep, file: None, written }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn rotate(&mut self) {
        self.file = None;
        for i in (1..self.keep).rev() {
            let from = numbered(&self.path, i);
            if from.exists() {
                let _ = fs::rename(&from, numbered(&self.path, i + 1));
            }
        }
        if self.keep > 0 {
            let _ = fs::rename(&self.path, numbered(&self.path, 1));
        } else {
            let _ = fs::remove_file(&self.path);
        }
        self.written = 0;
    }

    pub fn write_line(&mut self, line: &str) {
        let bytes = line.len() as u64 + 1;
        if self.written > 0 && self.written + bytes > self.max_bytes {
            self.rotate();
        }
        if self.file.is_none() {
            self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        }
        if let Some(file) = self.file.as_mut() {
            if writeln!(file, "{line}").is_ok() {
                self.written += bytes;
            }
        }
    }
}

fn numbered(path: &Path, n: usize) -> PathBuf {
    let mut name = path.file_name().map(|s| s.to_os_string()).unwrap_or_default();
    name.push(format!(".{n}"));
    path.with_file_name(name)
}

pub type SharedLog = Arc<Mutex<RotatingLog>>;

pub fn shared(path: PathBuf) -> SharedLog {
    Arc::new(Mutex::new(RotatingLog::new(path, MAX_BYTES, KEEP)))
}

fn unix_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A supervisor event line (spawn, exit, restart) in the same file.
pub fn event(log: &SharedLog, message: &str) {
    if let Ok(mut log) = log.lock() {
        log.write_line(&format!("=== [jarvis {}] {message}", unix_secs()));
    }
}

/// Copies one child stream into the log, line by line, on its own thread.
pub fn pump<R: Read + Send + 'static>(log: SharedLog, stream: R, tag: &'static str) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.split(b'\n') {
            let Ok(raw) = line else { break };
            let text = String::from_utf8_lossy(&raw);
            let text = text.trim_end_matches('\r');
            if let Ok(mut log) = log.lock() {
                log.write_line(&format!("{tag} {text}"));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_at_the_size_cap_and_keeps_only_n_files() {
        let dir = std::env::temp_dir().join(format!("jarvis-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("server.log");
        let mut log = RotatingLog::new(path.clone(), 100, 2);
        for i in 0..40 {
            log.write_line(&format!("line {i:02} ........")); // 18 bytes + newline
        }
        drop(log);
        assert!(path.exists());
        assert!(numbered(&path, 1).exists());
        assert!(numbered(&path, 2).exists());
        assert!(!numbered(&path, 3).exists(), "only KEEP rotated files survive");
        assert!(fs::metadata(&path).unwrap().len() <= 100);
        let newest = fs::read_to_string(&path).unwrap();
        assert!(newest.contains("line 39"));
        let _ = fs::remove_dir_all(&dir);
    }
}
