//! Opens links in the user's default browser instead of dropping them.
//!
//! WebView2 inside Tauri silently ignores `target="_blank"` links and
//! `window.open()` unless the host handles `NewWindowRequested`. So in the
//! desktop app every "open in a new tab" link did nothing: a lead's own
//! website, the local preview (`*.localhost:8091`), the SEO audit PDF, the
//! map listing.
//!
//! - `NewWindowRequested`: any http(s)/mailto/tel URI goes to the default
//!   browser through `ShellExecuteW`, and the request is marked handled so no
//!   popup window opens. That includes same-origin links such as
//!   `/__seo-audit-files`: the browser reaches the same loopback server.
//! - `NavigationStarting`: a plain link that would take the main window away
//!   from the OS (another origin) is cancelled and opened externally, so the
//!   app never ends up stranded on a third-party site.
//!
//! Anything else (javascript:, file:, data:, unknown schemes) is left alone
//! and never handed to the shell.

use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use webview2_com::{CoTaskMemPWSTR, NavigationStartingEventHandler, NewWindowRequestedEventHandler};
use windows::core::{Result as WinResult, HSTRING, PWSTR};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::config::app_port;
use crate::supervisor;

pub fn open_links_externally(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window
        .with_webview(|platform_webview| {
            let controller = platform_webview.controller();
            let webview: ICoreWebView2 = match unsafe { controller.CoreWebView2() } {
                Ok(webview) => webview,
                Err(err) => {
                    log::warn!("Jarvis: couldn't reach the WebView2 core for link handling: {err}");
                    return;
                }
            };
            if let Err(err) = install_handlers(&webview) {
                log::warn!("Jarvis: couldn't install the external-link handlers: {err}");
            } else {
                log::info!("Jarvis: external links now open in the default browser");
            }
        })
        .map_err(Into::into)
}

fn external_scheme(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    ["http://", "https://", "mailto:", "tel:"].iter().any(|s| lower.starts_with(s))
}

fn is_app_url(uri: &str) -> bool {
    uri.eq_ignore_ascii_case("about:blank") || supervisor::is_app_url(uri, app_port())
}

fn open_in_default_browser(uri: &str) {
    let op = HSTRING::from("open");
    let file = HSTRING::from(uri);
    let result = unsafe { ShellExecuteW(None, &op, &file, None, None, SW_SHOWNORMAL) };
    // ShellExecuteW reports success as a value greater than 32.
    if (result.0 as isize) <= 32 {
        log::warn!("Jarvis: the default browser didn't open {uri} (code {})", result.0 as isize);
    }
}

fn install_handlers(webview: &ICoreWebView2) -> WinResult<()> {
    let new_window = NewWindowRequestedEventHandler::create(Box::new(|_sender, args| {
        let Some(args) = args else { return Ok(()) };
        let mut raw = PWSTR::null();
        unsafe { args.Uri(&mut raw) }?;
        let uri = CoTaskMemPWSTR::from(raw).to_string();
        if external_scheme(&uri) {
            unsafe { args.SetHandled(true) }?;
            open_in_default_browser(&uri);
        }
        Ok(())
    }));
    let mut token: i64 = 0;
    unsafe { webview.add_NewWindowRequested(&new_window, &mut token) }?;

    let navigation = NavigationStartingEventHandler::create(Box::new(|_sender, args| {
        let Some(args) = args else { return Ok(()) };
        let mut raw = PWSTR::null();
        unsafe { args.Uri(&mut raw) }?;
        let uri = CoTaskMemPWSTR::from(raw).to_string();
        if !is_app_url(&uri) && external_scheme(&uri) {
            unsafe { args.SetCancel(true) }?;
            open_in_default_browser(&uri);
        }
        Ok(())
    }));
    let mut token: i64 = 0;
    unsafe { webview.add_NavigationStarting(&navigation, &mut token) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_urls_stay_inside() {
        assert!(is_app_url("http://localhost:8081/leads"));
        assert!(is_app_url("http://127.0.0.1:8081/"));
        assert!(is_app_url("about:blank"));
        assert!(!is_app_url("http://localhost:80812/evil"));
        assert!(!is_app_url("http://dundas-dental.localhost:8091/"));
        assert!(!is_app_url("https://www.dundasdental.com.au/"));
    }

    #[test]
    fn only_safe_schemes_go_to_the_shell() {
        assert!(external_scheme("https://example.com"));
        assert!(external_scheme("HTTP://example.com"));
        assert!(external_scheme("tel:+61298711110"));
        assert!(external_scheme("mailto:hi@example.com"));
        assert!(!external_scheme("file:///C:/Windows/System32/calc.exe"));
        assert!(!external_scheme("javascript:alert(1)"));
        assert!(!external_scheme("ms-settings:"));
    }
}
