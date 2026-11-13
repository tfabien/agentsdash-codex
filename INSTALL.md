# Install agentsdash-codex

> **For Codex or Claude Code.** A user asked you to install the agentsdash hooks for Codex. Follow the steps in order, run the commands yourself,
> check each result and report. Do not edit other files in `~/.codex/`. Stop and tell the user when a step fails.

## 1. Requirements

```bash
node --version      # v18 or higher
codex --version     # a Codex version with hooks
```

If Node.js is missing or older than 18, ask the user to install it from https://nodejs.org and stop.

## 2. Get the adapter

```bash
git clone https://github.com/tfabien/agentsdash-codex
cd agentsdash-codex
```

## 3. Add the hooks

```bash
node scripts/install_codex_hooks.mjs          # shows what will be written
node scripts/install_codex_hooks.mjs --write  # merges into ~/.codex/hooks.json, other hooks stay
```

The command written points at `scripts/notify.mjs` of this clone: do not move the folder afterwards.

## 4. Trust the hooks and open the page

Tell the user to run `/hooks` in Codex, review the nine agentsdash hooks and trust them (Codex skips new hooks until then), then start a new Codex session.
The page is http://127.0.0.1:8765/ . The first hook downloads the hub into `~/.agentsdash/core/<version>/`: the first event is dropped, the next one starts it.
Check with `curl http://127.0.0.1:8765/health` (`core` and `protocol` are shown).

## Troubleshooting

| Need | Command or cause |
|---|---|
| Nothing on the page | The hooks are not trusted yet (`/hooks`), or the session was opened before the install. |
| Port 8765 busy | Set `{"host": "127.0.0.1:8777"}` in `~/.agentsdash/config.json` or `AGENTSDASH_HOST=127.0.0.1:8777`. |
| See what a hook sends | `echo '{"hook_event_name":"Stop","session_id":"abcd1234","cwd":"."}' \| AGENTSDASH_DRY_RUN=1 node scripts/notify.mjs` prints the event. |
| Remove | Delete the agentsdash entries (commands containing `notify.mjs`) from `~/.codex/hooks.json`. |
