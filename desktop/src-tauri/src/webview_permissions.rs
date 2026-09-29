//! Best-effort microphone auto-grant, scoped to the Agentic OS's own origin.
//!
//! WebView2 shows a native "localhost:8081 wants to use your microphone"
//! prompt the first time the page asks, which is a perfectly reasonable
//! fallback on its own. This module tries to skip it: it hooks
//! `ICoreWebView2::PermissionRequested` and calls `SetState(ALLOW)` only when
//! the requested kind is `Microphone` *and* the requesting `Uri` starts with
//! our server's origin (`http://localhost:<port>`, 8081 by default). Every other request (wrong
//! kind, wrong origin, or a failure reaching the WebView2 core) is left
//! alone, so WebView2 falls back to its normal one-time prompt.
//!
//! If this ever fails to install (logged, not fatal), the app still works —
//! see docs/DESKTOP-APP.md for what "falling back to the native prompt"
//! looks like in practice.

use webview2_com::CoTaskMemPWSTR;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};
use webview2_com::PermissionRequestedEventHandler;
use windows::core::{Result as WinResult, PWSTR};

use crate::config::app_port;
use crate::supervisor;

pub fn allow_microphone_for_localhost(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window
        .with_webview(|platform_webview| {
            let controller = platform_webview.controller();
            let webview: ICoreWebView2 = match unsafe { controller.CoreWebView2() } {
                Ok(webview) => webview,
                Err(err) => {
                    log::warn!(
                        "Jarvis: couldn't reach the WebView2 core to pre-grant the microphone \
                         (falling back to WebView2's own prompt): {err}"
                    );
                    return;
                }
            };

            if let Err(err) = install_handler(&webview) {
                log::warn!(
                    "Jarvis: couldn't install the microphone permission handler \
                     (falling back to WebView2's own prompt): {err}"
                );
            } else {
                log::info!(
                    "Jarvis: microphone auto-grant installed for http://localhost:{}",
                    app_port()
                );
            }
        })
        .map_err(Into::into)
}

fn install_handler(webview: &ICoreWebView2) -> WinResult<()> {
    let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
        let Some(args) = args else {
            return Ok(());
        };

        let mut kind = Default::default();
        unsafe { args.PermissionKind(&mut kind) }?;
        if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
            return Ok(());
        }

        let mut uri_raw = PWSTR::null();
        unsafe { args.Uri(&mut uri_raw) }?;
        let uri = CoTaskMemPWSTR::from(uri_raw).to_string();

        if supervisor::is_app_url(&uri, app_port()) {
            log::info!("Jarvis: auto-granting microphone to {uri}");
            unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW) }?;
        } else {
            log::info!("Jarvis: leaving microphone prompt to WebView2 for {uri} (not our origin)");
        }
        Ok(())
    }));

    let mut token: i64 = 0;
    unsafe { webview.add_PermissionRequested(&handler, &mut token) }
}
