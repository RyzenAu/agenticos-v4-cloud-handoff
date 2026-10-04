//! Reports WebView2 navigation outcomes for app URLs to the supervisor.
//!
//! Before 28 Sep 2026 a navigation that failed (the server died mid-load, a
//! Vite restart dropped the connection) left WebView2's own error page up
//! forever: nothing ever retried. `NavigationCompleted` now records the
//! outcome in `Supervisor::nav_event`; the supervision loop shows the
//! readable recovery screen and navigates back with backoff.
//!
//! Cancelled navigations are ignored: `external_links.rs` cancels off-origin
//! navigations on purpose (they open in the default browser instead).

use std::sync::Arc;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, COREWEBVIEW2_WEB_ERROR_STATUS, COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED,
};
use webview2_com::{CoTaskMemPWSTR, NavigationCompletedEventHandler};
use windows::core::{Result as WinResult, BOOL, PWSTR};

use crate::supervisor::Supervisor;

pub fn report_navigation_outcomes(window: &tauri::WebviewWindow, supervisor: Arc<Supervisor>) -> tauri::Result<()> {
    window
        .with_webview(move |platform_webview| {
            let controller = platform_webview.controller();
            let webview: ICoreWebView2 = match unsafe { controller.CoreWebView2() } {
                Ok(webview) => webview,
                Err(err) => {
                    log::warn!("Jarvis: couldn't reach the WebView2 core to watch navigations: {err}");
                    return;
                }
            };
            if let Err(err) = install_handler(&webview, supervisor) {
                log::warn!("Jarvis: couldn't install the navigation watcher: {err}");
            } else {
                log::info!("Jarvis: navigation failures now retry with a recovery screen");
            }
        })
        .map_err(Into::into)
}

fn install_handler(webview: &ICoreWebView2, supervisor: Arc<Supervisor>) -> WinResult<()> {
    let handler = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
        let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
        let mut raw = PWSTR::null();
        unsafe { sender.Source(&mut raw) }?;
        let uri = CoTaskMemPWSTR::from(raw).to_string();
        if !crate::config::is_app_url(&uri) {
            return Ok(());
        }
        let mut success = BOOL::default();
        unsafe { args.IsSuccess(&mut success) }?;
        if success.as_bool() {
            supervisor.nav_event.store(-1, std::sync::atomic::Ordering::SeqCst);
            return Ok(());
        }
        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
        unsafe { args.WebErrorStatus(&mut status) }?;
        if status == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
            return Ok(());
        }
        log::warn!("Jarvis: navigation to {uri} failed (WebView2 error status {})", status.0);
        supervisor.nav_event.store(status.0 + 1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }));
    let mut token: i64 = 0;
    unsafe { webview.add_NavigationCompleted(&handler, &mut token) }
}
