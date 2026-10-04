"""Away mode relay for the Hermes gateway (installed from AgenticOS-v4/scripts/away-mode/hermes-plugin).

His away-mode commands on Telegram never reach the agent: this hook matches them by grammar only,
drops them from normal dispatch, and hands them (with the Telegram user and chat IDs the adapter
verified) to the OS on this PC over loopback. The OS decides everything, including whether the
sender is Usman's own chat; its reply is sent back into the same chat. /stop is also left to
Hermes, so its own running agent stops too. Nothing here reads a Hermes credential.

Free text (anything that isn't a command) is first checked by the OS against its money policy
(AUDIT F4 F5): a money request ("pay the electricity bill") is refused in code and never reaches
the agent. The OS is the one policy while it answers. When it can't be reached (down, restarting,
hung, an error, or no relay set up), text that looks like money is refused here from a small,
deliberately broad word list, so money never reaches Hermes; everything else still goes to Hermes,
his remote channel when the PC is down (REVIEW-S2 fix 3). This hook runs synchronously in the
gateway's inbound path, so the OS check waits about a second at most, and an unreachable OS is
remembered for 30 seconds instead of stalling every message.
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
    # like a command (not the 1-second free-text check), answered by the OS's approval service (Track 6).
    r"|(?:yes|approve|approved|y|no|deny|denied|reject|n)\s+[A-Za-z0-9]{4}[-\s][A-Za-z0-9]{4}\s*[.!]?"
    r")$",
    re.IGNORECASE,
)
_ALSO_HERMES = re.compile(r"^\s*/stop(?:@\w+)?\s*$", re.IGNORECASE)
# Free text waits at most this long (seconds) for the OS's money check.
_FREE_TEXT_TIMEOUT = 1.0
# After the OS couldn't be reached, don't try again for this long (seconds): one stall, not one per message.
_DOWN_FOR = 30.0
_down_until = 0.0
# Only while the OS can't be reached: text that looks like money is refused here (fails closed for money,
# open for everything else). Broad on purpose; the OS's own policy is the precise one.
_MONEY_WORDS = re.compile(
    r"\b(?:pay(?!\s+(?:attention|heed|respects?)\b)\w*|paid|payments?|pay\s?id|bpay|osko|transfer\w*|wire|remit\w*"
    r"|buy\w*|bought|purchas\w*|(?<!in\s)orders?|ordering|renew\w*|top\s?up|topup|recharge|checkout"
    r"|subscri\w*|upgrade\s+(?:\w+\s+){0,2}(?:plan|subscription|tier|account|membership)"
    r"|refund\w*|reimburs\w*|withdraw\w*|deposit\w*|donat\w*|zakat|zakah|sadaqah|charity"
    r"|bitcoin|btc|eth|ethereum|crypto\w*|nfts?|shares|stocks?|etfs?|trad(?:e|es|ing)|invest\w*"
    r"|bet|bets|betting|gambl\w*|casino|pokies|lotto\w*|lotter(?:y|ies)|wager\w*"
    r"|bank\w*|netbank|commbank|nab|westpac|anz|stripe|paypal|afterpay|zip\s?pay|invoice\w*|bills?"
    r"|dollars?|bucks|cents|aud|usd|grand)\b"
    r"|[$€£¥₹]\s?\d|\b\d[\d,.]*\s?(?:dollars|bucks|aud|usd)\b",
    re.IGNORECASE,
)
_OFFLINE_MONEY_REPLY = "I can't check that with the OS on the PC right now, and money is yours to do yourself. Nothing was done."
_UNREACHABLE: dict = {"unreachable": True}


def _config() -> dict:
    try:
        return json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _relay(payload: dict, timeout: float = 20, fallback: dict | None = None) -> dict:
    cfg = _config()
    url = str(cfg.get("url") or "http://127.0.0.1:8081/__away/telegram")
    if not url.startswith("http://127.0.0.1:") and not url.startswith("http://localhost:"):
        return fallback if fallback is not None else {"handled": True, "reply": "Away mode relay is misconfigured (not loopback)."}
    try:
        token = Path(str(cfg.get("tokenFile") or "")).read_text(encoding="utf-8").strip()
    except Exception:
        return fallback if fallback is not None else {"handled": True, "reply": "Away mode isn't set up on the PC (no relay token)."}
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except Exception as exc:  # the OS is down, restarting, hung, or answered with an error
        logger.warning("away-mode relay failed: %s", exc)
        return fallback if fallback is not None else {"handled": True, "reply": "Away mode can't reach the OS on the PC right now (is it running?). Nothing was done."}


def _check_free_text(payload: dict) -> dict | None:
    """The OS's answer for free text ({"handled": bool, "reply": ...}), or None when it can't be reached."""
    global _down_until
    if time.monotonic() < _down_until:
        return None
    result = _relay(payload, timeout=_FREE_TEXT_TIMEOUT, fallback=_UNREACHABLE)
    if result is _UNREACHABLE or not isinstance(result, dict) or not isinstance(result.get("handled"), bool):
        _down_until = time.monotonic() + _DOWN_FOR
        return None
    return result


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


def _send(adapter, loop, chat_id: str, reply) -> None:
    if not reply or adapter is None or loop is None:
        return
    try:
        asyncio.run_coroutine_threadsafe(adapter.send(chat_id, str(reply)[:3500]), loop)
    except Exception as exc:
        logger.warning("away-mode reply failed: %s", exc)


def on_dispatch(event=None, gateway=None, **_kwargs):
    text = ""
    try:
        if event is None or getattr(event, "internal", False):
            return None
        source = event.source
        platform = getattr(getattr(source, "platform", None), "value", str(getattr(source, "platform", "")))
        text = (getattr(event, "text", None) or "").strip()
        if platform != "telegram" or not text:
            return None
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

        if not _COMMAND.match(text):
            # Free text: the OS checks it against its money policy first (a quick, pure check), so a
            # money request is refused in code before the agent (a model) sees it.
            result = _check_free_text(payload)
            if result is None:
                # The OS can't be reached: money-shaped text fails closed, everything else goes to Hermes.
                if _MONEY_WORDS.search(text):
                    _send(adapter, loop, chat_id, _OFFLINE_MONEY_REPLY)
                    return {"action": "skip", "reason": "OS unreachable; money is never sent to Hermes"}
                return None
            if not result.get("handled"):
                return None
            _send(adapter, loop, chat_id, result.get("reply"))
            return {"action": "skip", "reason": "refused by the OS (money)"}

        def work():
            result = _relay(payload)
            _send(adapter, loop, chat_id, result.get("reply") if isinstance(result, dict) else None)

        threading.Thread(target=work, name="away-mode-relay", daemon=True).start()
        if _ALSO_HERMES.match(text):
            return {"action": "allow"}
        return {"action": "skip", "reason": "away-mode command"}
    except Exception as exc:
        logger.warning("away-mode hook error: %s", exc)
        # Even on an unexpected error, money-shaped free text never goes on to Hermes.
        if text and not _COMMAND.match(text) and _MONEY_WORDS.search(text):
            return {"action": "skip", "reason": "hook error; money is never sent to Hermes"}
        return None


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", on_dispatch)
