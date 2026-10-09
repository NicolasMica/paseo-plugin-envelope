Envelope hands the variables of a `.env` file to every agent session when it opens, whether the session is created, resumed, refreshed or imported. Agents get the variables in their process environment, so their shell commands see them without any shell setup.

Agents receive the values themselves and can read, print or send them anywhere, so only put in the file what every agent may see. There is no per-project, per-provider or per-agent scope.

## Setup

Envelope needs Paseo 0.11.0 or later, and `npm` on the daemon's `PATH` to install its `dotenv` dependency.

Set the path of your `.env` in Settings → Plugins → Envelope → Environment, for example `~/.config/paseo-plugin-envelope/.env`. Until a path is set, the plugin reads nothing and injects nothing. The path must be absolute or start with `~/`. The change applies at the next session opening, without reloading the plugin. A status line under the field shows **Not configured**, or the path in effect and whether the daemon can read a regular file there, checked from its type and permissions without opening the file. The setting is stored in `~/.paseo/plugin-settings/envelope/settings.json` as `{"version": 1, "values": {"envFile": "~/path/to/.env"}}`, which you or an agent can also edit by hand.

Below the path, a Variables section lists the file's keys in file order, each marked injected, injected except for the providers whose own env sets it, or protected. Values are masked; Show fetches one value from the daemon on demand and Hide removes it. Refresh re-reads the file and hides every value, and so does leaving the screen. A key passed with `paseo run --env` isn't listed: it wins for that creation only. A shown value travels to the app over its connection to the daemon (end-to-end encrypted through the relay) and stays in the app's memory while shown; it is never cached, stored or logged, but any client connected to the daemon can ask for one.

Make the file's directory `chmod 700` and the file `chmod 600`: the plugin warns when group or others can read the file. The file uses dotenv syntax: `KEY=value` per line, no `$VAR` interpolation, and an unquoted `#` starts a comment, so quote values that contain one.

Earlier versions read `~/.config/paseo-plugin-envelope/.env` (or under `$XDG_CONFIG_HOME`) when no path was set. That default is gone: if you relied on it, set the path to that file.

The settings and the file are read again each time a session opens. A running agent keeps its environment until it is reloaded.

## Precedence

- A variable set in the provider's env in Paseo's config, including a provider it extends, keeps its value.
- A variable passed with `paseo run --env` wins when the agent is created, then the `.env` value applies after a resume or refresh, because Paseo doesn't keep it. A secret passed this way also ends up in your shell history.
- `PATH`, `HOME`, `SHELL`, `USER` and `PASEO_*` are never injected.

## Secrets guideline

When a new agent is created and the plugin would inject at least one variable into its later sessions (a `paseo run --env` key doesn't count, since Paseo drops it on resume), it appends a short "Environment secrets" guideline to the agent's system prompt: use variables by reference (`"$NAME"`), never print a value, check one with `[ -n "$NAME" ] && echo set`, and tell the user when one is missing. It names no variable. It comes after the agent's own system prompt and before Paseo's "Append system prompt", and it is kept on resume. The check happens once, at creation: an agent created while the file was missing or empty, or while its provider env set every key, never gets it, even if it receives variables later. Only agents created after the plugin is enabled get it, and ACP providers like Copilot ignore it. It is guidance, not a guarantee: only put in the file what every agent may see.

## Logs and limits

The plugin logs only counts, paths, error codes and error names, never variable names or values; the settings screen shows names, and values on request. Only regular files are read: a FIFO or a directory is refused. If the plugin can't read Paseo's config within 5 seconds, or hits an error it catches, the agent starts without the `.env` variables. On OpenCode, injected variables make Paseo start a dedicated OpenCode server for the session.
