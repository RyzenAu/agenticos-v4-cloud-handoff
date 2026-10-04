"""Still images for site drafts from GPT Image 2 on the owner's ChatGPT subscription.

This runs inside Hermes' own Python environment and calls Hermes' ``openai-codex`` image plugin
(the ChatGPT/Codex OAuth route Hermes' ``image_gen`` tool uses), so no API key is involved and
the credential never leaves Hermes' own code and is never printed. It asks the Codex
``images/generations`` endpoint for a size and quality and saves the PNG.

Pinned account (owner, 24 Sep 2026): stills run on ONE named entry of Hermes' ``openai-codex``
credential pool (default ``openai-2``, Usman's ChatGPT Plus), never on the pool's rotation. If
that entry is missing, exhausted, on the wrong plan or can't be refreshed, the script refuses
(exit 4) instead of falling back to another account. Only this script is pinned; Hermes'
config and its own rotation for chat are untouched.

    <hermes venv python> gpt_image_codex.py --prompt-file p.txt --size 1024x1536 --quality high --out hero.png

Prints one JSON line: {"ok": true, "path": ..., "pixel_size": "WxH", "reported_size": ...} or
{"ok": false, "error": ...}.
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import sys


def _plan_of(token: str) -> str:
    """The ChatGPT plan claim from the token's own payload (read locally, never printed)."""
    try:
        part = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        return str((claims.get("https://api.openai.com/auth") or {}).get("chatgpt_plan_type") or "")
    except Exception:
        return ""


def pinned_token(label: str, expect_plan: str) -> "tuple[str | None, str]":
    """Token for exactly the pool entry named ``label`` or (None, reason). Never another entry."""
    from agent.credential_pool import load_pool
    from agent.auxiliary_client import _pool_runtime_api_key

    pool = load_pool("openai-codex")
    matches = [e for e in pool.entries() if getattr(e, "label", None) == label]
    if len(matches) != 1:
        return None, f"Hermes openai-codex pool has {len(matches)} entries labelled {label!r}; refusing to use any other account."
    entry = matches[0]
    from agent.credential_pool import STATUS_DEAD, _exhausted_until
    import time

    # Rotation would skip a dead or cooling-down entry; for a pinned call that means stop.
    if entry.last_status == STATUS_DEAD:
        return None, f"Pool entry {label!r} is marked dead (sign in again with `hermes auth`); refusing to fall back."
    until = _exhausted_until(entry)
    if until is not None and until > time.time():
        return None, f"Pool entry {label!r} hit its usage limit until {time.strftime('%Y-%m-%d %H:%M', time.localtime(until))}; refusing to fall back."
    if pool._entry_needs_refresh(entry):
        refreshed = pool.try_refresh_matching(credential_id=entry.id)
        if refreshed is None or refreshed.id != entry.id:
            return None, f"Pool entry {label!r} needs a token refresh that failed; refusing to fall back."
        entry = refreshed
    token = _pool_runtime_api_key(entry)
    if not token:
        return None, f"Pool entry {label!r} has no usable token."
    if expect_plan and _plan_of(token) != expect_plan:
        return None, f"Pool entry {label!r} is not on the {expect_plan!r} plan; refusing."
    return token, ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--size", default="1536x1024")
    parser.add_argument("--quality", default="high", choices=["low", "medium", "high"])
    parser.add_argument("--out", required=True)
    parser.add_argument("--pool-label", default="openai-2", help="Hermes openai-codex pool entry to use; no fallback.")
    parser.add_argument("--expect-plan", default="plus", help="Refuse unless the pinned account's plan matches ('' to skip).")
    parser.add_argument("--hermes-agent", default=os.path.join(os.environ.get("LOCALAPPDATA", ""), "hermes", "hermes-agent"))
    args = parser.parse_args()

    root = args.hermes_agent
    sys.path.insert(0, root)
    try:
        spec = importlib.util.spec_from_file_location(
            "hermes_openai_codex_image", os.path.join(root, "plugins", "image_gen", "openai-codex", "__init__.py"))
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        with open(args.prompt_file, encoding="utf-8") as fh:
            prompt = fh.read().strip()
        token, why = pinned_token(args.pool_label, args.expect_plan)
        if not token:
            print(json.dumps({"ok": False, "pinned": args.pool_label, "error": why}))
            return 4
        payload = module._post_image_request(token, prompt=prompt, size=args.size, quality=args.quality, input_images=None)
        data = payload.get("data") or []
        b64 = data[0].get("b64_json") if data and isinstance(data[0], dict) else None
        if not b64:
            print(json.dumps({"ok": False, "error": "The Codex images API returned no image data."}))
            return 3
        raw = base64.b64decode(b64)
        with open(args.out, "wb") as fh:
            fh.write(raw)
        print(json.dumps({"ok": True, "account": args.pool_label, "path": args.out, "pixel_size": module._png_pixel_size(raw), "reported_size": payload.get("size"), "reported_quality": payload.get("quality")}))
        return 0
    except Exception as exc:  # report, never a traceback with request details
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:300]}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
