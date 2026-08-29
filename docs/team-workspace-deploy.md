# Team-workspace VPS deploy runbook

Deploys the **same zmrng server binary** onto a VPS as the shared **Team workspace**
server (D2 of `.agents/plans/layman-onboarding-grill.md`). This is the one piece of the
layman-onboarding vision that is ops, not code: the architecture (T1–T4) is wired and
unit-tested but has never been booted end-to-end over a tailnet.

The chat-only partner (Partner A, Pro sub) contributes through this workspace — shared
channels + the `@agent` bot + the "Send to my zmrng" handoff into a technical partner's
local backlog. They never run the local app; they paste a URL into Settings.

> **Security perimeter — read first.** There is **no app-code auth**. Handles are
> self-asserted; **tailnet membership IS the access control.** The workspace port MUST be
> reachable *only* over Tailscale. Never expose it publicly, never port-forward it, never
> put it behind a public reverse proxy. This is a documented POC precondition — the app
> deliberately has no auth gate.

---

## 0. Prerequisites (on the VPS)

- **Tailscale** installed and `tailscale up` (the box must have a tailnet IPv4 —
  `tailscale ip -4`). Every partner's machine must also be on the same tailnet.
- **Node** `>=20.11.0 <23` and **npm**.
- **git**, and read access to the zmrng repo remote.
- A user that can write the install dir and manage systemd (root or a sudoer).

Confirm in one shot:

```bash
node -v && npm -v && git --version && tailscale ip -4
```

---

## 1. Deploy

From a checkout of this repo on the VPS (or copy just `scripts/deploy-workspace.sh` over):

```bash
# Defaults: /opt/zmrng-workspace, branch main, port 4500, db in /var/lib/zmrng-workspace.
bash scripts/deploy-workspace.sh
```

The script is **idempotent** — re-run it to pick up a new commit. It:

1. Preflights node/npm/git/tailscale.
2. Clones (or `fetch` + `reset --hard origin/<branch>`) into `ZMRNG_INSTALL_DIR`.
3. `npm ci` + `npm run build`.
4. Creates a stable `ZMRNG_DATA_DIR` so `zmrng.db` survives redeploys, and writes a
   **starter env file** at `ZMRNG_ENV_FILE` (only if absent — it never clobbers your edits).
5. Prints (or, with `ZMRNG_APPLY_FIREWALL=1`, applies) the tailnet-only firewall rule.
6. Writes + enables a systemd unit and restarts it.
7. Health-checks `GET /api/config` on the tailnet address.

### Overrides (all optional)

| Env var | Default | Purpose |
|---|---|---|
| `ZMRNG_REPO_URL` | origin of the running checkout | git remote to clone |
| `ZMRNG_INSTALL_DIR` | `/opt/zmrng-workspace` | where to clone/pull |
| `ZMRNG_BRANCH` | `main` | branch to deploy |
| `ZMRNG_PORT` | `4500` | workspace port (**check it is free** on a shared box) |
| `ZMRNG_DATA_DIR` | `/var/lib/zmrng-workspace` | stable dir for `zmrng.db` |
| `ZMRNG_ENV_FILE` | `/etc/zmrng/workspace.env` | env file systemd loads |
| `ZMRNG_SERVICE` | `zmrng-workspace` | systemd unit name |
| `ZMRNG_RUN_USER` | current user | unix user the service runs as |
| `ZMRNG_APPLY_FIREWALL` | `0` (print only) | `1` = actually apply the nft rule |
| `ZMRNG_SKIP_SYSTEMD` | `0` | `1` = build + configure only, no systemd |

> **Shared box note.** This VPS may already run other services. Pick a `ZMRNG_PORT`
> that is free (`ss -ltn | grep :4500`), and the firewall step is **print-only by
> default** so the deploy never silently mutates a shared box's netfilter — review the
> rule, then apply it yourself or re-run with `ZMRNG_APPLY_FIREWALL=1`.

---

## 2. Configure the env, then restart

Edit `ZMRNG_ENV_FILE` (default `/etc/zmrng/workspace.env`). The workspace-relevant vars:

| Var | Meaning |
|---|---|
| `ZMRNG_PORT` | port the server listens on |
| `ZMRNG_DATA_DIR` | where `zmrng.db` lives (channels/messages/members persist here) |
| `ZMRNG_WORKSPACE_URL` | server-side default URL surfaced via `GET /api/config`; teammates can instead set it per-client in Settings |
| `ZMRNG_WORKSPACE_REPO_PATH` | absolute path to a read-only reference checkout the `@agent` bot `git pull`s before answering; blank = pull skipped |
| `ZMRNG_WORKSPACE_BOT_AGENT` | id of the `AgentTarget` (`config/agents.json`) that acts as the bot; blank = first configured agent |
| `ZMRNG_WORKSPACE_BOT_HANDLE` | the @mention handle that triggers the bot (default `@agent`) |
| `ZMRNG_WORKSPACE_SCROLLBACK` | how many recent messages are relayed to the bot as context (default `20`) |
| `ZMRNG_WORKSPACE_AGENT_TIMEOUT_MS` | per-request timeout capping a hung bot (default `60000`) |

The `@agent` bot is **optional** — leave `ZMRNG_WORKSPACE_REPO_PATH` and
`ZMRNG_WORKSPACE_BOT_AGENT` blank to run the workspace (channels + presence + handoff)
without a bot. To enable it you also need a `config/agents.json` in the install dir
defining at least one `AgentTarget` (the U4 `fetch(agent.url)` adapter).

> **Never set `ANTHROPIC_API_KEY` in this env.** This instance serves the shared
> workspace only — it never spawns task workers. `oauth` mode strips the key regardless.

Apply changes:

```bash
sudo systemctl restart zmrng-workspace
sudo systemctl status  zmrng-workspace --no-pager
journalctl -u zmrng-workspace -n 50 --no-pager
```

---

## 3. Firewall — restrict the port to the tailnet

The server binds `0.0.0.0`, so the tailnet-only guarantee comes from the firewall.
`nftables`:

```bash
sudo nft add rule inet filter input tcp dport 4500 iifname != "tailscale0" drop
```

`iptables` equivalent:

```bash
sudo iptables -A INPUT -p tcp --dport 4500 ! -i tailscale0 -j DROP
```

Verify from OFF the tailnet that the port is unreachable, and from a tailnet peer that it
is:

```bash
# From a tailnet peer (should connect):
curl -fsS http://<tailnet-ip>:4500/api/config | head -c 200
```

---

## 4. Smoke test (the one live check D2 asks for)

Two people (or two browsers, each with a distinct handle) on the tailnet:

1. **Roster** — both open the app, go to the **Team** tab, set the workspace URL to
   `http://<tailnet-ip>:4500`, and self-assert a handle. Each should see **both** handles
   in the live presence roster.
2. **Channels + live messaging** — one posts in `#general`; the other sees it arrive live
   (no refresh). Reload → scrollback loads over `GET /api/channels/:id/messages`.
3. **@agent bot** (only if configured) — someone posts `@agent <question>` in a channel;
   the bot replies as a server-controlled `kind='agent'` message. It **talks/plans only,
   never executes code**.
4. **Send to my zmrng** — from a message, a technical teammate clicks **Send to my
   zmrng**; their LOCAL new-task box opens pre-filled with the provenance line
   (`From team channel #<name> (message #<id>)`). Repo suggestion resolves only against
   their OWN local registry — no VPS repoId is auto-bound.

If all four pass over the tailnet, D2 is done.

---

## 5. Update / rollback

- **Update:** re-run `bash scripts/deploy-workspace.sh` (pulls latest, rebuilds,
  restarts). `zmrng.db` in `ZMRNG_DATA_DIR` is untouched.
- **Rollback:** `ZMRNG_BRANCH=<tag-or-sha> bash scripts/deploy-workspace.sh` (the script
  `reset --hard`s to `origin/<branch>`; pass a branch/tag that points at the good commit).
- **Stop / remove:** `sudo systemctl disable --now zmrng-workspace` and delete
  `/etc/systemd/system/zmrng-workspace.service`.

---

## Troubleshooting

- **Health check fails after deploy** — `journalctl -u zmrng-workspace -n 80 --no-pager`.
  Usual causes: port already in use (pick a free `ZMRNG_PORT`), or a bad `EnvironmentFile`
  line.
- **Teammate sees "can't connect"** — confirm both machines are on the tailnet
  (`tailscale status`), the URL uses the **tailnet** IP/MagicDNS name (not a public IP or
  `localhost`), and the firewall rule didn't also block `tailscale0`.
- **Bot never replies** — `ZMRNG_WORKSPACE_BOT_AGENT` must match an id in
  `config/agents.json`; check the timeout (`ZMRNG_WORKSPACE_AGENT_TIMEOUT_MS`) and the
  server log for the fetch error. A missing/blank agent config is a graceful no-op, not a
  crash.
