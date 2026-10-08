# Envelope design

Design from the /office-hours session of 2026-10-08. The issues on the [Envelope board](https://github.com/users/NicolasMica/projects/4) derive from it.

## Problem

Paseo agents need environment variables, mostly secrets (`NOTION_TOKEN_V2`, API keys), without every developer hacking their shell. The current setup combines an `AGENT_ENV_AUTO` flag set on the providers in `~/.paseo/config.json` and a `~/.zshenv` line that sources a `.env` picked from `git config user.email`. It only works in zsh, it can't be shared, and the variables only reach shell commands: not the agent process, not its MCP servers.

## Verified constraints (Paseo 0.11 plugin docs)

- `server.before("agent.session_open")` runs on create, resume, refresh and import. The request has `agentId`, `workspaceId`, `provider`, `cwd`, `reason`, `purpose` and `env`, and only `env` is editable. `env` is an override map that excludes the daemon's inherited environment, and it is not persisted.
- `server.before("agent.create")` can add `mcpServers` (stdio or http), but only at creation.
- No API lets a plugin host an MCP server or add a subcommand to the `paseo` CLI.
- `defineSettings` stores plain JSON on the host ("not a credential vault").
- Plugins are disabled by default: everyone has to enable them once in Settings → Plugins. Install with `paseo plugin install github:owner/repo`, update with `paseo plugin update`.
- Hooks time out after 30 s, and a failing `before` hook fails the session opening.

## Decisions

- **V1 = a single global `.env`**: no project level, no UI, no MCP. The plugin is a single server file with no settings.
- Variables are injected when a session opens. An agent that is already running only sees a change after it is resumed.
- Values are stored in plain text in a file. Keychain and 1Password come later.
- The CLI is out of the ideal version as long as Paseo doesn't allow extending its CLI.
- `request.env` must keep the last word over the `.env`. Codex suggested the opposite; we keep this order so that a global `.env` never overwrites the explicit env of Paseo or of a provider. Assumption to verify (see the spike, #3).

## Rejected approaches

- **Full platform from the start** (UI, MCP and inspector): too much surface before the core is validated. It becomes the roadmap (P2).
- **Delegating to direnv** (`direnv export json`): forces direnv and `direnv allow` on every colleague, and runs shell code on every session opening.

## Risks

- High: values leaking through logs. The plugin only logs names, including in error paths.
- High: broad exposure. The global `.env` goes to every agent, of every provider. Accepted for V1; scoping comes in V2.
- Medium: inheritance by stdio MCP servers is unproven. We test it instead of promising it.
- Medium: surprising precedence when a variable is removed. We test it and document it.

## Long-term vision

A colleague installs the plugin, opens any checkout, and their agents get the right credentials for that project. The app shows the loaded variables, where they come from, and which ones are missing compared with the repo's `.env.example`.
