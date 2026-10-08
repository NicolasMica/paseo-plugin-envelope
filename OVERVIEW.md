Envelope hands the variables of a `.env` file to every agent session when it opens, whether the session is created, resumed, refreshed or imported. Agents get the variables in their process environment, so their shell commands see them without any shell setup.

Agents receive the values themselves and can read, print or send them anywhere, so only put in the file what every agent may see. There is no per-project, per-provider or per-agent scope.

## Setup

Envelope needs Paseo 0.11.0 or later, and `npm` on the daemon's `PATH` to install its `dotenv` dependency.

By default the plugin reads `~/.config/paseo-plugin-envelope/.env`, or `paseo-plugin-envelope/.env` under the daemon's `$XDG_CONFIG_HOME` when it is set. Make the directory `chmod 700` and the file `chmod 600`: the plugin warns when group or others can read the file. The file uses dotenv syntax: `KEY=value` per line, no `$VAR` interpolation, and an unquoted `#` starts a comment, so quote values that contain one.

To read another file, set its path in Settings → Plugins → Envelope → Environment. The path must be absolute or start with `~/`; leave it empty to use the default path. The change applies at the next session opening, without reloading the plugin. A status line under the field shows the path in effect and whether the daemon can read a regular file there, checked from its type and permissions without opening the file. The setting is stored in `~/.paseo/plugin-settings/envelope/settings.json` as `{"version": 1, "values": {"envFile": "~/path/to/.env"}}`, which you or an agent can also edit by hand.

The settings and the file are read again each time a session opens. A running agent keeps its environment until it is reloaded.

## Precedence

- A variable set in the provider's env in Paseo's config, including a provider it extends, keeps its value.
- A variable passed with `paseo run --env` wins when the agent is created, then the `.env` value applies after a resume or refresh, because Paseo doesn't keep it. A secret passed this way also ends up in your shell history.
- `PATH`, `HOME`, `SHELL`, `USER` and `PASEO_*` are never injected.

## Logs and limits

The plugin logs only counts, paths, error codes and error names, never variable names or values. Only regular files are read: a FIFO or a directory is refused. If the plugin can't read Paseo's config within 5 seconds, or hits an error it catches, the agent starts without the `.env` variables. On OpenCode, injected variables make Paseo start a dedicated OpenCode server for the session.
