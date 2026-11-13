# agentsdash-codex

The Codex adapter of [agentsdash](https://github.com/tfabien/agentsdash), an agent dashboard in your browser.
Codex hooks send what each session and sub-agent is doing (state, tools, questions, plan) to a local hub that draws one page
with a tile per session. The hub (the core) is a separate repository; the hook downloads it on first use.

Status: first version, written against the Codex hooks documentation (events, payload fields). Tokens, context fill and the session title
need the Codex transcript format and are not sent yet; the plan comes from the `update_plan` tool.

## Install

Node.js 18 or later and Codex with hooks enabled. From a checkout of this repository:

```bash
node scripts/install_codex_hooks.mjs            # prints the hooks.json that would be written
node scripts/install_codex_hooks.mjs --write    # merges it into ~/.codex/hooks.json
```

Then run `/hooks` in Codex once and trust the new hooks (Codex skips hooks it has not reviewed), and open a new session. The page is <http://127.0.0.1:8765/>.
The first hook downloads the hub from the releases of [tfabien/agentsdash](https://github.com/tfabien/agentsdash) into `~/.agentsdash/core/<version>/`
(sha256 checked); the first event is dropped, the next one finds it. Install help: [INSTALL.md](INSTALL.md).

The repository also holds `hooks/hooks.json` and `.codex-plugin/plugin.json`, the plugin form (hooks bundled with `${PLUGIN_ROOT}`), not tried yet.

## What is here

```text
scripts/   notify.mjs (hook -> POST /event v2), hub_client.mjs (post, find the core, version rule), core_install.mjs (download),
           install_codex_hooks.mjs, plan_tracker.mjs, transcript_usage.mjs, common.mjs
hooks/     hooks.json for the plugin form
test/      tests (node --test test/*.test.mjs); fixtures/events.jsonl are the recorded events
```

Tests: `node --test test/*.test.mjs`. After changing `notify.mjs`, run `node test/tools/record_events.mjs` and copy the file to the core
repository (`hub/test/fixtures/events-codex.jsonl`). The wire protocol (version 2) is written in the core repository (`docs/protocol.md`).
Options and variables (`AGENTSDASH_HOST`, `AGENTSDASH_MASK=1`, `AGENTSDASH_CORE_DIR`...) are the same as in
[agentsdash-claude](https://github.com/tfabien/agentsdash-claude); `~/.agentsdash/config.json` is shared.
