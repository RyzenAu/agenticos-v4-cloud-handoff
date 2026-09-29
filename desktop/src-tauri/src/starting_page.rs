//! The window's very first page: a local, self-contained "starting Jarvis"
//! screen, shown immediately (instead of a blank/`about:blank` window) while
//! a background thread attaches to or spawns the shared Bun server.
//!
//! Why a `data:` URL rather than serving `assets/starting.html` through
//! Tauri's own asset protocol: this window's `url` is `about:blank` in
//! `tauri.conf.json` (the real content is always the remote OS at
//! `http://localhost:8081`, navigated to at runtime), so there's no existing
//! wiring for a second local asset root, and the exact asset-protocol origin
//! Tauri picks varies by platform/config. A `data:` URL sidesteps all of
//! that — it's inert to `external_links.rs` (neither `NewWindowRequested`
//! nor `NavigationStarting` treats `data:` as an external scheme, so it's
//! never redirected to the system browser) and needs no extra Cargo
//! dependency to build (plain percent-encoding, not base64).
//!
//! This page only narrates ("starting" / "still starting" / "recovering");
//! it never redirects itself. `lib.rs`'s background thread polls
//! `supervisor::wait_for_ready` and, once the server answers, calls
//! `WebviewWindow::navigate()` from Rust to leave this page. That split
//! matters: an earlier version had this page redirect itself with
//! `location.href` once `/__token` answered, and that was observed, live,
//! to leave the WebView2 controller rendering only a ~15px sliver of the
//! real page (content painted in a thin strip on the left, the rest black)
//! even though the navigation itself had genuinely succeeded — confirmed by
//! attaching to the WebView2 remote debugging port and seeing the correct
//! URL loaded behind the blank-looking window. Tauri's own `navigate()`
//! from Rust doesn't have that problem (it's what this app used
//! exclusively before this starting page existed), so it stays the only
//! thing that ever navigates the window away from here.

const TEMPLATE: &str = include_str!("../assets/starting.html");

/// Builds the `data:` URL for the starting/recovering page, with the version
/// label and the current status burned in as visible text (HTML-escaped: the
/// status can carry paths and error messages).
pub fn starting_page_url(version_label: &str, headline: &str, detail: &str, phase: &str) -> tauri::Url {
    let html = TEMPLATE
        .replace("__VERSION__", &escape_html(version_label))
        .replace("__HEADLINE__", &escape_html(headline))
        .replace("__DETAIL__", &escape_html(detail))
        .replace("__PHASE__", &escape_html(phase));
    let url = format!("data:text/html;charset=utf-8,{}", percent_encode(&html));
    url.parse().expect("starting page data: URL should always parse")
}

/// JavaScript that updates the page already showing (never navigates).
pub fn status_script(headline: &str, detail: &str, phase: &str) -> String {
    let quote = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| String::from("\"\""));
    format!(
        "window.__jarvisStatus && window.__jarvisStatus({}, {}, {});",
        quote(headline),
        quote(detail),
        quote(phase)
    )
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Minimal percent-encoding sufficient for a `data:` URL body: keeps
/// unreserved characters literal, escapes everything else (including
/// whitespace and all of HTML's punctuation) as `%XX`. Deliberately not a
/// crate dependency — this only ever encodes our own small, trusted
/// template, not external input.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_parseable_data_url_with_the_version_visible() {
        let url = starting_page_url("Jarvis v3.6.1 (abc1234)", "Starting", "x", "starting");
        assert_eq!(url.scheme(), "data");
        let decoded = url.as_str();
        // The version text should survive round-trip-able (space -> %20, parens
        // encoded) rather than being dropped by the template replace.
        assert!(decoded.contains("Jarvis%20v3.6.1%20%28abc1234%29"));
    }

    #[test]
    fn never_looks_like_an_external_scheme() {
        let url = starting_page_url("x", "h", "d", "starting");
        assert!(!url.as_str().starts_with("http"));
    }

    #[test]
    fn never_assigns_a_navigation_target() {
        // Regression guard for the WebView2 rendering bug this file's module
        // doc explains: this page must stay purely cosmetic and never
        // navigate itself (`lib.rs`'s Rust-driven `navigate()` must stay the
        // only thing that ever does). A real self-redirect assigns
        // `location.href` or `location.assign(...)`; explanatory comments
        // about that constraint (this test's own neighbours included) only
        // ever *mention* those names, they don't write to them, so this
        // narrower check doesn't trip on prose the way matching "fetch("
        // or "location.href" as bare substrings would.
        assert!(!TEMPLATE.contains("location.href ="));
        assert!(!TEMPLATE.contains("location.assign("));
    }

    #[test]
    fn status_is_escaped_in_the_page_and_json_quoted_in_updates() {
        let url = starting_page_url("v", "<b>", "a & b", "stopped");
        // "<" -> "&lt;" -> percent-encoded "%26lt%3B".
        assert!(url.as_str().contains("%26lt%3Bb%26gt%3B"));
        assert!(url.as_str().contains("a%20%26amp%3B%20b"));
        let js = status_script("Recovering", r#"it said "no""#, "recovering");
        assert_eq!(
            js,
            r#"window.__jarvisStatus && window.__jarvisStatus("Recovering", "it said \"no\"", "recovering");"#
        );
    }
}
