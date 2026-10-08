# Envelope design

Design from the /office-hours session of 2026-10-08. The issues on the [Envelope board](https://github.com/users/NicolasMica/projects/4) derive from it.

## Problem

Paseo agents need environment variables, mostly secrets (`NOTION_TOKEN_V2`, API keys), without every developer hacking their shell. The current setup combines an `AGENT_ENV_AUTO` flag set on the providers in `~/.paseo/config.json` and a `~/.zshenv` line that sources a `.env` picked from `git config user.email`. It only works in zsh, it can't be shared, and the variables only reach shell commands: not the agent process, not its MCP servers.

## Verified constraints (Paseo 0.11)

From the plugin docs, and from the spike in #3 (live daemon 0.11.1 and its bundled source):

- `server.before("agent.session_open")` runs on create, resume, refresh and import. The request has `agentId`, `workspaceId`, `provider`, `cwd`, `reason`, `purpose` and `env`, and only `env` is editable. `env` is an override map that excludes the daemon's inherited environment, and it is not persisted.
- On `create`, `request.env` holds only the env of the create request (`paseo run --env`), after `agent.create` hooks. On `resume`, `refresh` and `import` it is empty: Paseo doesn't persist create-time env, so it is gone at the next session opening.
- The provider env (`agents.providers.<provider>.env` in `config.json`) is not in `request.env`. The final env stacks the daemon's environment, then the provider env, then `request.env` after hooks, then `PASEO_AGENT_ID` and `PASEO_AGENT_CWD`, so a key the plugin adds overrides the provider env.
- `paseo.config.get()` from the hook context returns `providers.<provider>.env`, and `request.provider` is the bare provider id that keys it. A custom provider that `extends` another merges the base provider's env with its own, but `config.get()` returns each provider's own env, not the merged one.
- Paseo doesn't log the hook payload or the final env at the default `info` level (checked with sentinel values in `daemon.log`). At `trace`, it logs raw provider events, tool output included, so a secret an agent prints lands in `daemon.log`. At any level, it also stays in the provider's own transcript (see #19).
- A plugin's stdout and stderr go to `daemon.log` at `info` and to `paseo plugin logs`. A failing `before` hook's error message is logged at `error` and shown in the app.
- On OpenCode, any launch env key other than `PASEO_AGENT_ID` and `PASEO_AGENT_CWD` makes Paseo start a dedicated OpenCode server for the session instead of the shared one.
- `server.before("agent.create")` can add `mcpServers` (stdio or http), but only at creation.
- No API lets a plugin host an MCP server or add a subcommand to the `paseo` CLI.
- `defineSettings` stores plain JSON on the host ("not a credential vault").
- Plugins are disabled by default: everyone has to enable them once in Settings → Plugins. Install with `paseo plugin install github:owner/repo`, update with `paseo plugin update`.
- Hooks time out after 30 s, and a failing `before` hook fails the session opening.

## Decisions

- **V1 = a single global `.env`**: no project level, no UI, no MCP. The plugin is a single server file with no settings.
- Variables are injected when a session opens. An agent that is already running only sees a change after it is resumed or refreshed.
- Values are stored in plain text in a file. Keychain and 1Password come later.
- The CLI is out of the ideal version as long as Paseo doesn't allow extending its CLI.
- Explicit env keeps the last word over the `.env`: a `.env` key is injected only if it is absent from `request.env` and from the env of the agent's provider, including the providers it `extends`, read with `paseo.config.get()`. Paseo applies `request.env` after the provider env, so relying on `request.env` alone would let the global `.env` overwrite a provider's explicit env (#3). Codex suggested letting the `.env` win; we keep this order so that a global `.env` never overwrites the explicit env of a create request or of a provider. Two limits: the `.env` does override the daemon's inherited environment, except for the protected keys (`PATH`, `HOME`, `SHELL`, `USER`, `PASEO_*`), and a key passed with `paseo run --env` only wins at create, because Paseo drops it at the next session opening and the `.env` value then applies.

## Rejected approaches

- **Full platform from the start** (UI, MCP and inspector): too much surface before the core is validated. It becomes the roadmap (P2).
- **Delegating to direnv** (`direnv export json`): forces direnv and `direnv allow` on every colleague, and runs shell code on every session opening.

## Risks

- High: values leaking through logs. The plugin's output goes to `daemon.log`, and a hook's error message is logged and shown in the app, so the plugin only logs names, including in error paths and thrown errors.
- High: broad exposure. The global `.env` goes to every agent, of every provider. Accepted for V1; scoping comes in V2.
- Medium: inheritance by stdio MCP servers is unproven. We test it instead of promising it.
- Medium: surprising precedence when a variable is removed, or when a resume or refresh drops a `paseo run --env` key and the `.env` value takes over. We test it and document it.

## Long-term vision

A colleague installs the plugin, opens any checkout, and their agents get the right credentials for that project. The app shows the loaded variables, where they come from, and which ones are missing compared with the repo's `.env.example`.
