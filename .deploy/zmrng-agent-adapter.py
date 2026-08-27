#!/usr/bin/env python3
"""
zmrng team-agent adapter.

Bridges zmrng's AgentResponder U4 contract to the local cci-bridge
(OpenAI-compatible server wrapping the `claude` CLI = "VPS Hermes").

zmrng POSTs:   { "messages": [{role, content}...], "context": {channelId, checkoutPath} }
adapter -> cci-bridge /v1/chat/completions (prepends a team-agent system prompt)
adapter returns: { "reply": "<assistant text>" }   (zmrng persists it as kind='agent')

Talks and plans only. Never executes code (no tools exposed to it here anyway).
Binds loopback — only the local zmrng server calls it.
"""
import json
import os
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BRIDGE_URL = os.environ.get("ADAPTER_BRIDGE_URL", "http://127.0.0.1:8787/v1/chat/completions")
BRIDGE_MODEL = os.environ.get("ADAPTER_MODEL", "sonnet")
LISTEN_HOST = os.environ.get("ADAPTER_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("ADAPTER_PORT", "4600"))
BRIDGE_TIMEOUT = float(os.environ.get("ADAPTER_BRIDGE_TIMEOUT", "110"))

SYSTEM_PROMPT = (
    "You are the shared team agent inside a zmrng team-workspace channel. "
    "Several teammates share this channel; each human message is prefixed with the "
    "sender's handle (e.g. 'alice: ...') so you can tell people apart. You were "
    "summoned by an @agent mention.\n\n"
    "Your role: help the team think, plan, and reason — answer questions, sketch "
    "designs, break work into steps, weigh trade-offs, and give clear recommendations. "
    "You TALK AND PLAN ONLY. You never execute code, never open worktrees, never claim "
    "to have run or changed anything — you have no tools and no filesystem access here. "
    "If someone wants code actually built, tell them to use 'Send to my zmrng' to spin "
    "up a local task.\n\n"
    "Be concise and direct. Lead with the answer or recommendation. Skip pleasantries."
)


def call_bridge(messages):
    body = json.dumps({
        "model": BRIDGE_MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + messages,
    }).encode("utf-8")
    req = urllib.request.Request(
        BRIDGE_URL,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=BRIDGE_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    choices = data.get("choices") or []
    if choices:
        msg = choices[0].get("message") or {}
        content = msg.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
    return ""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        # health probe
        self._send(200, {"ok": True, "model": BRIDGE_MODEL})

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            parsed = json.loads(raw.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(400, {"error": f"bad request: {e}"})
            return
        messages = parsed.get("messages")
        if not isinstance(messages, list) or not messages:
            self._send(400, {"error": "missing messages"})
            return
        # keep only well-formed {role, content} string pairs
        clean = [
            {"role": m.get("role", "user"), "content": m["content"]}
            for m in messages
            if isinstance(m, dict) and isinstance(m.get("content"), str)
        ]
        try:
            reply = call_bridge(clean)
        except urllib.error.URLError as e:  # noqa: BLE001
            self._send(502, {"error": f"bridge unreachable: {e}"})
            return
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"adapter error: {e}"})
            return
        self._send(200, {"reply": reply})

    def log_message(self, format, *args):  # noqa: A002 — silence default stderr logging
        pass


def main():
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"zmrng-agent-adapter listening on {LISTEN_HOST}:{LISTEN_PORT} -> {BRIDGE_URL} ({BRIDGE_MODEL})")
    server.serve_forever()


if __name__ == "__main__":
    main()
