// Dictation: "type <text>" / "dictate: <text>" puts his words into the focused app via the
// clipboard and Ctrl+V, then puts his previous clipboard back. It only ever runs on those explicit
// words, never on its own, and refuses when the window in front is Windows itself (desktop, Start,
// lock or sign-in screens), this OS, or anything whose title suggests a password, sign-in or bank.
// It never presses Enter, so nothing is sent or submitted.
import { core, looksSecret } from "./text";
import { psText, type PsHost } from "./ps-host";
import { foregroundWindow, type WindowInfo } from "./windows";

/** `app`: type only into that app's window, waiting up to ~8 s for it to come to the front ("open Notepad and type …"). */
export type TypeRequest = { skill: "type"; action: "type"; text: string; app?: string };
export const MAX_TYPED = 2000;

export function typeIntent(utterance: string): TypeRequest | null {
  const c = core(utterance).replace(/\s+/g, " ").trim();
  if (c.length > MAX_TYPED + 40) return null;
  const m = c.match(/^(?:type(?: out)?(?: this)?|dictate(?: this)?)\s*[:,-]?\s+(.+)$/i) ?? c.match(/^(?:type|dictate)\s*:\s*(.+)$/i);
  if (!m) return null;
  let text = m[1].trim().replace(/^["“](.*)["”]$/, "$1");
  // "type in the search box …" belongs to the browser tools, not the focused window.
  if (/^(?:in|into)\s+(?:the\s+)?(?:search|address|url)\b/i.test(text) || /\b(?:into|in) the (?:search|address|url) (?:box|bar|field)$/i.test(text)) return null;
  // Whisper adds a full stop to short phrases he didn't mean to punctuate.
  if (text.split(" ").length <= 4 && /^[^.!?]*\.$/.test(text)) text = text.slice(0, -1);
  if (!text) return null;
  return { skill: "type", action: "type", text: text.slice(0, MAX_TYPED) };
}

export const SHELL_CLASSES = /^(?:progman|workerw|shell_traywnd|shell_secondarytraywnd|windows\.ui\.core\.corewindow|#32770)$/i;
export const SHELL_PROCESSES = /^(?:lockapp|logonui|consent|credentialuibroker|searchhost|searchapp|startmenuexperiencehost|shellexperiencehost|textinputhost|applicationframehost|keepass(?:xc)?|1password|bitwarden|lastpass|dashlane|nordpass|enpass)$/i;
export const SENSITIVE_TITLE =
  /pass(?:word|code|phrase|key)|log ?in\b|login|log on|sign ?in|signin|sign up|credential|\bbank|banking|netbank|commbank|westpac|\banz\b|\bnab\b|st\.? george|ing direct|paypal|stripe|\bwallet|coinbase|binance|crypto|authenticat|verification|\b2fa\b|\botp\b|one-time|security (?:code|question)|checkout|payment|card details|\bcvv\b|keychain|1password|bitwarden|lastpass|keepass|dashlane/i;
export const THIS_OS = /agentic os|claude os|jarvis hud|localhost:8081|127\.0\.0\.1:8081/i;

/** Why typing into this window is refused, or null when it's fine. Pure. */
export function refuseWindow(w: WindowInfo | null): string | null {
  if (!w || !w.handle) return "I can't tell which window is in front, sir, so I won't type blind.";
  if (SHELL_CLASSES.test(w.cls) || SHELL_PROCESSES.test(w.process) || (/^explorer$/i.test(w.process) && !w.title))
    return "That's Windows itself in front, sir, not an app. Click into the box you want and ask again.";
  if (THIS_OS.test(w.title)) return "The OS is in front, sir. Click into the app you want me to type in, then ask again.";
  if (SENSITIVE_TITLE.test(w.title)) return "That window looks like a sign-in, password or banking screen, sir, so I won't type into it.";
  return null;
}

/**
 * "Type my password", "type my card number into the checkout": he names a credential, not the words to type. Jarvis never types
 * a password, PIN, card or bank number, code or key; it says so, and never types the words themselves (J4, AUDIT-JARVIS #uns236).
 */
const CREDENTIAL_WORDS = /\b(?:password|passcode|passphrase|pin(?: number| code)?|cvv|cvc|card (?:number|details)|(?:credit|debit|bank) (?:card )?(?:number|details)|tfn|tax file number|bsb|account number|security code|one[- ]time (?:code|password)|2fa (?:code)?|otp|api key|secret key|access token|recovery (?:code|key)|seed phrase)\b/i;
export function namesCredential(text: string): boolean {
  const t = String(text ?? "").trim();
  return t.split(/\s+/).length <= 10 && /\b(?:my|his|her|the|our|your)\b/i.test(t) && CREDENTIAL_WORDS.test(t);
}
export const NEVER_TYPES_CREDENTIALS = "I never type passwords, PINs or card numbers, and I haven't typed anything. Those are yours to type.";

export async function answerType(req: TypeRequest, ps: PsHost): Promise<string> {
  const text = req.text.replace(/[\r\n]+/g, " ").trim();
  if (!text) return "There's nothing to type, sir.";
  if (namesCredential(text)) return NEVER_TYPES_CREDENTIALS;
  if (looksSecret(text)) return "That looks like a password or key, sir. Type that one yourself.";
  let front = await foregroundWindow(ps);
  if (req.app) {
    // Just opened: wait for its window to be in front, and type nowhere else.
    const want = req.app.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/)[0] ?? "";
    const isApp = (w: typeof front) => !!w && !!want && `${w.process} ${w.title}`.toLowerCase().includes(want);
    for (let i = 0; i < 32 && !isApp(front); i++) {
      await new Promise((r) => setTimeout(r, 250));
      front = await foregroundWindow(ps);
    }
    if (!isApp(front)) return `${req.app} didn't come to the front, sir, so I didn't type anything.`;
    // A new window is still drawing its text box: a beat before the paste.
    await new Promise((r) => setTimeout(r, 600));
    // Windows 11 Notepad reopens his last tabs: a fresh tab, so nothing already there is typed into.
    if (/^notepad$/i.test(front!.process)) {
      await ps.run(`if ([JarvisWin]::GetForegroundWindow().ToInt64() -eq ${Math.trunc(front!.handle)}) { [Windows.Forms.SendKeys]::SendWait('^n') }; 'ok'`, 5000);
      await new Promise((r) => setTimeout(r, 500));
      front = await foregroundWindow(ps);
    }
  }
  const refusal = refuseWindow(front);
  if (refusal) return refusal;
  // One script, so the check and the paste can't be split by a window change: it re-checks the
  // same window is still in front, keeps every clipboard format, then pastes.
  const out = (
    await ps.run(
      [
        `$h = ${Math.trunc(front!.handle)};`,
        "if ([JarvisWin]::GetForegroundWindow().ToInt64() -ne $h) { 'MOVED' } else {",
        "$global:JarvisClipSaved = $null;",
        "try { $o = [Windows.Forms.Clipboard]::GetDataObject(); if ($o) { $s = New-Object Windows.Forms.DataObject; foreach ($f in $o.GetFormats($false)) { try { $v = $o.GetData($f); if ($null -ne $v) { $s.SetData($f, $v) } } catch {} }; $global:JarvisClipSaved = $s } } catch {};",
        `[Windows.Forms.Clipboard]::SetText(${psText(text)});`,
        "[Windows.Forms.SendKeys]::SendWait('^v');",
        "Start-Sleep -Milliseconds 150;",
        "'TYPED' }",
      ].join(" "),
      8000,
    )
  ).trim();
  if (out === "TYPED") {
    // His own clipboard goes back a moment later: some apps (Windows 11 Notepad among them) read
    // the clipboard lazily after Ctrl+V, and restoring too soon pastes the old contents instead.
    void ps
      .run(
        "Start-Sleep -Milliseconds 900; try { $s = $global:JarvisClipSaved; if ($s -and $s.GetFormats().Length) { [Windows.Forms.Clipboard]::SetDataObject($s, $true) } else { [Windows.Forms.Clipboard]::Clear() } } catch {}; $global:JarvisClipSaved = $null; 'RESTORED'",
        5000,
      )
      .catch(() => undefined);
    return "Typed.";
  }
  if (out === "MOVED") return "The window changed as I went to type, sir, so I stopped.";
  return "I couldn't type that just now, sir. Nothing was pasted.";
}
