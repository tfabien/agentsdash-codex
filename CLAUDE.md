# agentsdash-codex

The Codex adapter of agentsdash: Codex hooks run `scripts/notify.mjs`, which turns each payload into a wire protocol v2 event (`POST /event`) for the local hub.
The hub is the core, repository `tfabien/agentsdash`; the Claude adapter is `agentsdash-claude` (this repository started from a copy of its scripts).

Language: chat with the user in French. Code comments, documentation and on-screen text are in English.

## Rules

- `notify.mjs` never blocks, never prints, exits 0 and gives up after 1.5 s (Codex waits for hooks; the default timeout is 600 s, the hooks here ask for 5 s, 1 s for SessionEnd).
- The adapter never imports code from a core; it speaks the protocol (`docs/protocol.md` of the core). `PROTOCOL` and `MIN_CORE` are in `scripts/common.mjs`.
- `scripts/common.mjs`, `hub_client.mjs`, `core_install.mjs` are copies of the Claude adapter's files (same behaviour: finding and downloading the core, version rule). Fix them in both repositories.
- Codex payload fields: `session_id`, `cwd`, `hook_event_name`, `model`, `turn_id`, `permission_mode`, `tool_name`, `tool_input`, `agent_id`, `agent_type`, `last_assistant_message`, `transcript_path` (see the Codex hooks documentation). Codex hooks need review and trust (`/hooks`).
- Not done: tokens and context from the Codex rollout transcript, session title, quotas, rules prompts. Codex plugin install (`.codex-plugin/plugin.json`) is untested.
- Tests: `node --test test/*.test.mjs` (a directory argument fails on Node 24). `test/fixtures/mini_hub.mjs` stands in for the core.
- Edit code with an editor tool or a Python script file: a shell here-document or `sed` turns `\n` into a real newline.
