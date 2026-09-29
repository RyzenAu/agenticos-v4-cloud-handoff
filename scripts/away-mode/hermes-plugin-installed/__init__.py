"""Away mode relay for the Hermes gateway (installed from AgenticOS-v4/scripts/away-mode/hermes-plugin).

His away-mode commands on Telegram never reach the agent: this hook matches them by grammar only,
drops them from normal dispatch, and hands them (with the Telegram user and chat IDs the adapter
verified) to the OS on this PC over loopback. The OS decides everything, including whether the
sender is Usman's own chat; its reply is sent back into the same chat. /stop is also left to
Hermes, so its own running agent stops too. Nothing here reads a Hermes credential.

Free-text money ORDERS (S2d, lead decision 29 Sep; installed only when the owner says so). Hermes' Telegram
tools (the browser on Jarvis Chrome, computer_use) have no money gate of their own, so a message that looks like
money is first put to the OS, whose shared classifier (chatMoneyOrder in scripts/jarvis-execution/spoken-money.ts)
decides: an order ("buy 1 bitcoin", "settle the AGL invoice") is refused there; a question or reminder ("what did
I spend", "remind me to pay the bill Friday") comes back not handled and goes to Hermes as usual. Text with no
money words at all is never sent anywhere: it goes straight to Hermes with no added wait. If the OS can't be
reached within a second, money-worded text is refused here unless it's a question, a reminder, writing or a
line addressed to a person ("I can't do payments or trades from chat"); everything else still goes to Hermes. An
unreachable OS is remembered for 30 seconds.

The tool guard (S2e). A two-turn chat ("shall I place the order?" then "yes") passes any per-message check, so
this plugin also registers pre_tool_call: before every Hermes browser_* or computer_use action that isn't just
reading, the OS's own money checks decide (POST /__away/tool-guard: the S2c final/money-button gate, the money-page
context, money windows and hosts, card numbers). If the OS can't be reached, browser and screen input is blocked.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
import urllib.request
from pathlib import Path

logger = logging.getLogger("hermes.plugins.away_mode")

_HERE = Path(__file__).resolve().parent
# relay.json (written by the installer): {"url": "http://127.0.0.1:8081/__away/telegram", "tokenFile": "..."}
_CONFIG_FILE = _HERE / "relay.json"

_COMMAND = re.compile(
    r"^\s*(?:"
    r"/(?:away|task|log)(?:@\w+)?(?:\s[\s\S]*)?"
    r"|/(?:stop|status)(?:@\w+)?\s*"
    r"|(?:yes|approve|approved|y|no|deny|denied|reject|n)\s+(?=[A-Za-z]{0,3}\d)[A-Za-z0-9]{4}\s*[.!]?"
    # An approval code for a program's request (8 characters as XXXX-XXXX, docs/APPROVAL-CODES.md): relayed
    # like a command, answered by the OS's approval service (Track 6).
    r"|(?:yes|approve|approved|y|no|deny|denied|reject|n)\s+[A-Za-z0-9]{4}[-\s][A-Za-z0-9]{4}\s*[.!]?"
    r")$",
    re.IGNORECASE,
)
_ALSO_HERMES = re.compile(r"^\s*/stop(?:@\w+)?\s*$", re.IGNORECASE)

# --- free-text money orders (see the module docstring) --------------------------------------------------------
# Which free text is worth asking the OS about: any money word. Broad on purpose; the OS decides.
_MONEY_HINT = re.compile(
    r"\b(?:pay(?!\s+(?:attention|heed|respects?)\b)\w*|paid|payid|bpay|osko|transfer\w*|wire|remit\w*|buy\w*|bought|sell\w*|sold|purchas\w*"
    r"|(?:orders?|ordering)(?![^.?!]*\bby\b)|renew\w*|book\w*|tickets?|reserv\w*|flights?|grab|snag|cop|get\s+me|place\s+(?:it|the\s+order)"
    r"|sort\s+out(?=[^.?!]*\b(?:bill|invoice|payment|charges?|rent|rates|fees?)\b)"
    r"|top\s?up|topup|recharge|checkout|subscri\w*|upgrade|refund\w*|reimburs\w*|withdraw\w*|deposit\w*|donat\w*"
    r"|zakat|sadaqah|charity|settle|settlement|invoice\w*|bills?|charges?|owe|owing|debt|bitcoin|btc|eth|ethereum|sol|solana"
    r"|crypto\w*|coins?|nfts?|shares|stocks?|etfs?|trad(?:e|es|ing)|invest\w*|stake|staking|bet|bets|betting|gambl\w*"
    r"|casino|pokies|lotto\w*|lotter(?:y|ies)|wager\w*|punt|bank\w*|netbank|commbank|nab|westpac|anz|stripe|paypal"
    r"|afterpay|amazon|ebay|card|money|cash|funds|dollars?|bucks|cents|aud|usd)\b|[$\u20ac\u00a3\u00a5\u20b9\u20bf]",
    re.IGNORECASE,
)
# When the OS can't be reached, money-worded text is refused unless it's a question, a reminder or writing ("how do
# I pay…", "remind me to pay…", "draft an invoice…"), or a line addressed to a person ("Mehroz, can you buy milk?").
_NOT_AN_ORDER = re.compile(
    r"^\s*(?:hey\s+jarvis[,\s]+|jarvis[,\s]+)?(?:what|what's|whats|how|when|why|which|who|where|is|are|was|were|do|does|did|should|can\s+i|could\s+i"
    r"|remind|remember|note|draft|write|show|list|tell\s+me|explain|summari[sz]e)\b",
    re.IGNORECASE,
)
# A line addressed to one of the PEOPLE in the chat (their first names, written into relay.json by the installer
# from .operator-data/people.json). Only real names count: "Quick, buy 1 bitcoin" is an order (REVIEW S2e).
_TO_A_PERSON = re.compile(r"^\s*(?:(?:hey|hi|oi)\s+)?([^\W\d_][\w'\-]{1,30})\s*[,:]", re.UNICODE)
_CHAT_MONEY_REPLY = "I can't do payments or trades from chat. Nothing was done."
_FREE_TEXT_TIMEOUT = 1.0
_DOWN_FOR = 30.0
_down_until = 0.0


def _config() -> dict:
    try:
        return json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _relay(payload: dict) -> dict:
    cfg = _config()
    url = str(cfg.get("url") or "http://127.0.0.1:8081/__away/telegram")
    if not url.startswith("http://127.0.0.1:") and not url.startswith("http://localhost:"):
        return {"handled": True, "reply": "Away mode relay is misconfigured (not loopback)."}
    try:
        token = Path(str(cfg.get("tokenFile") or "")).read_text(encoding="utf-8").strip()
    except Exception:
        return {"handled": True, "reply": "Away mode isn't set up on the PC (no relay token)."}
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except Exception as exc:  # the OS is down or restarting
        logger.warning("away-mode relay failed: %s", exc)
        return {"handled": True, "reply": "Away mode can't reach the OS on the PC right now (is it running?). Nothing was done."}


def _ask_os(payload: dict) -> dict | None:
    """The OS's verdict on money-looking free text ({"handled": bool, "reply": ...}), or None if it can't be reached."""
    global _down_until
    if time.monotonic() < _down_until:
        return None
    cfg = _config()
    url = str(cfg.get("url") or "http://127.0.0.1:8081/__away/telegram")
    try:
        if not url.startswith("http://127.0.0.1:") and not url.startswith("http://localhost:"):
            raise ValueError("relay is not loopback")
        token = Path(str(cfg.get("tokenFile") or "")).read_text(encoding="utf-8").strip()
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=_FREE_TEXT_TIMEOUT) as response:
            result = json.loads(response.read().decode("utf-8") or "{}")
        if isinstance(result, dict) and isinstance(result.get("handled"), bool):
            return result
        raise ValueError("unexpected answer")
    except Exception as exc:  # down, hung, an error, or not set up
        logger.warning("away-mode money check unavailable: %s", exc)
        _down_until = time.monotonic() + _DOWN_FOR
        return None


def _people() -> set:
    names = _config().get("people")
    return {str(n).strip().split()[0].lower() for n in names if str(n).strip()} if isinstance(names, list) else set()


def _to_a_person(text: str) -> bool:
    m = _TO_A_PERSON.match(text)
    return bool(m) and m.group(1).lower() in _people()


def _offline_order(text: str) -> bool:
    """While the OS can't be reached: any money-worded text that isn't a question, reminder, writing or a line to a person."""
    return bool(_MONEY_HINT.search(text)) and not _NOT_AN_ORDER.match(text) and not _to_a_person(text)


def _send(adapter, loop, chat_id: str, reply) -> None:
    if not reply or adapter is None or loop is None:
        return
    try:
        asyncio.run_coroutine_threadsafe(adapter.send(chat_id, str(reply)[:3500]), loop)
    except Exception as exc:
        logger.warning("away-mode reply failed: %s", exc)


def _money_order_check(text: str, source, gateway):
    """Free text: None (goes to Hermes) or a skip when the OS, or the offline rule, calls it a money order."""
    if not _MONEY_HINT.search(text) or _to_a_person(text):
        return None
    payload = {
        "platform": "telegram",
        "user_id": str(getattr(source, "user_id", "") or ""),
        "chat_id": str(getattr(source, "chat_id", "") or ""),
        "chat_type": str(getattr(source, "chat_type", "") or ""),
        "text": text[:4000],
    }
    verdict = _ask_os(payload)
    if verdict is None:
        if not _offline_order(text):
            return None
        reply = _CHAT_MONEY_REPLY
    elif not verdict.get("handled"):
        return None
    else:
        reply = verdict.get("reply") or _CHAT_MONEY_REPLY
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    _send(_adapter(gateway, source) if gateway is not None else None, loop, payload["chat_id"], reply)
    return {"action": "skip", "reason": "money order: not done from chat"}


def _adapter(gateway, source):
    try:
        adapter = gateway._adapter_for_source(source)
        if adapter is not None:
            return adapter
    except Exception:
        pass
    try:
        return gateway.adapters.get(source.platform)
    except Exception:
        return None


def on_dispatch(event=None, gateway=None, **_kwargs):
    try:
        if event is None or getattr(event, "internal", False):
            return None
        source = event.source
        platform = getattr(getattr(source, "platform", None), "value", str(getattr(source, "platform", "")))
        text = (getattr(event, "text", None) or "").strip()
        if platform != "telegram" or not text:
            return None
        if not _COMMAND.match(text):
            return _money_order_check(text, source, gateway)
        payload = {
            "platform": platform,
            "user_id": str(getattr(source, "user_id", "") or ""),
            "chat_id": str(getattr(source, "chat_id", "") or ""),
            "chat_type": str(getattr(source, "chat_type", "") or ""),
            "text": text[:4000],
        }
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        adapter = _adapter(gateway, source) if gateway is not None else None
        chat_id = payload["chat_id"]

        def work():
            result = _relay(payload)
            reply = result.get("reply") if isinstance(result, dict) else None
            if not reply or adapter is None or loop is None:
                return
            try:
                asyncio.run_coroutine_threadsafe(adapter.send(chat_id, str(reply)[:3500]), loop)
            except Exception as exc:
                logger.warning("away-mode reply failed: %s", exc)

        threading.Thread(target=work, name="away-mode-relay", daemon=True).start()
        if _ALSO_HERMES.match(text):
            return {"action": "allow"}
        return {"action": "skip", "reason": "away-mode command"}
    except Exception as exc:
        logger.warning("away-mode hook error: %s", exc)
        # Even on an unexpected error, an order-shaped money message is not passed on to Hermes.
        try:
            text = (getattr(event, "text", None) or "").strip()
            if text and not _COMMAND.match(text) and _MONEY_HINT.search(text) and _offline_order(text):
                return {"action": "skip", "reason": "hook error; a money order is never sent to Hermes"}
        except Exception:
            pass
        return None


# --- the tool guard (S2e): before Hermes' browser and computer_use tools ---------------------------------------------
# A two-turn chat ("shall I place the order?" → "yes") gets past any per-message check, so the real gate is here:
# before every browser_* or computer_use action, the OS's own money checks (POST /__away/tool-guard) decide. Reading
# (snapshots, screenshots, scrolling, capture) is never asked about. If the OS can't be reached, browser and screen
# INPUT is blocked (fail closed); nothing else is touched.
_READ_ONLY_BROWSER = {"browser_snapshot", "browser_get_images", "browser_vision", "browser_console", "browser_scroll", "browser_back", "browser_vault_list"}
_READ_ONLY_SCREEN = {"capture", "list_apps", "list_windows", "wait", "scroll"}
_GUARD_TIMEOUT = 5.0
_GUARD_OFFLINE = (
    "Not done: the money check on the PC (AgenticOS) isn't answering, so browser and screen actions are paused. "
    "Nothing was pressed or typed. Start AgenticOS on the PC, then try again."
)


def _guarded(tool_name: str, args: dict) -> bool:
    if tool_name == "computer_use":
        return str(args.get("action", "")).lower() not in _READ_ONLY_SCREEN
    return tool_name.startswith("browser_") and tool_name not in _READ_ONLY_BROWSER


def _browser_get(task_id: str, what: list, field: str):
    """`agent-browser get ...` on Hermes' own browser session for this task (in-process); None if it can't be read."""
    try:
        from tools import browser_tool  # Hermes' own module, in-process
        key = browser_tool._last_session_key(task_id or "default")
        result = browser_tool._session._run_browser_command(key, "get", what)
        if isinstance(result, dict):
            for k in ("data", field, "result", "output", "stdout"):
                v = result.get(k)
                if isinstance(v, dict):
                    v = v.get(field) or v.get("result")
                if isinstance(v, str) and v.strip():
                    return v.strip()
    except Exception as exc:
        logger.debug("away-mode tool guard: couldn't read %s: %s", what, exc)
    return None


def _ref_label(ref, task_id: str):
    """The clicked element's text, read with Hermes' own browser session; None if it can't be read."""
    if not isinstance(ref, str) or not ref:
        return None
    text = _browser_get(task_id, ["text", ref if ref.startswith("@") else f"@{ref}"], "text")
    return text[:300] if text else None


def _page_url(task_id: str):
    """The address of the page Hermes' own browser session is on: the tab the tool acts on (REVIEW S2e). The OS
    reads THAT tab, not whichever Jarvis Chrome tab is first; without it, only an unambiguous visible tab."""
    url = _browser_get(task_id, ["url"], "url")
    return url[:2000] if url and re.match(r"^https?://", url, re.IGNORECASE) else None


def _guard_url() -> str:
    url = str(_config().get("url") or "http://127.0.0.1:8081/__away/telegram")
    return url.rsplit("/", 1)[0] + "/tool-guard"


def _ask_guard(payload: dict):
    """The OS's verdict ({"allow": bool, "message"?: str}), or None when it can't be reached."""
    url = _guard_url()
    try:
        if not url.startswith("http://127.0.0.1:") and not url.startswith("http://localhost:"):
            raise ValueError("relay is not loopback")
        token = Path(str(_config().get("tokenFile") or "")).read_text(encoding="utf-8").strip()
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=_GUARD_TIMEOUT) as response:
            verdict = json.loads(response.read().decode("utf-8") or "{}")
        return verdict if isinstance(verdict, dict) and isinstance(verdict.get("allow"), bool) else None
    except Exception as exc:
        logger.warning("away-mode tool guard unavailable: %s", exc)
        return None


def _safe_args(args: dict) -> dict:
    out = {}
    for k, v in list(args.items())[:30]:
        if isinstance(v, str):
            out[k] = v[:2000]
        elif isinstance(v, bool) or isinstance(v, (int, float)):
            out[k] = v
        elif isinstance(v, (list, tuple)) and len(v) <= 4 and all(isinstance(x, (int, float)) for x in v):
            out[k] = list(v)
    return out


def on_pre_tool_call(tool_name=None, args=None, task_id="", **_kwargs):
    try:
        name = str(tool_name or "")
        a = args if isinstance(args, dict) else {}
        if not _guarded(name, a):
            return None
        label = _ref_label(a.get("ref"), str(task_id or "")) if name == "browser_click" else None
        page_url = _page_url(str(task_id or "")) if name.startswith("browser_") and name != "browser_navigate" else None
        verdict = _ask_guard({"tool": name, "args": _safe_args(a), "label": label, "pageUrl": page_url})
        if verdict is None:
            return {"action": "block", "message": _GUARD_OFFLINE}
        if verdict.get("allow") is True:
            return None
        return {"action": "block", "message": str(verdict.get("message") or "Not done: a money action. Nothing was pressed or typed.")[:600]}
    except Exception as exc:
        logger.warning("away-mode tool guard error: %s", exc)
        # Fail closed for input on the browser or his screen; anything else goes on.
        try:
            if _guarded(str(tool_name or ""), args if isinstance(args, dict) else {}):
                return {"action": "block", "message": _GUARD_OFFLINE}
        except Exception:
            pass
        return None


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", on_dispatch)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
