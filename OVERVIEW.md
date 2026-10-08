Envelope hands the variables of a `.env` file to every agent session when it opens, whether the session is created, resumed, refreshed or imported. Agents receive the values themselves and can read, print or send them anywhere, so only put in the file what every agent may see.

## Setup

By default the plugin reads `~/.config/paseo-plugin-envelope/.env`, or `paseo-plugin-envelope/.env` under the daemon's `$XDG_CONFIG_HOME` when it is set. Restrict the file to your user with `chmod 600`: the plugin warns when group or others can read it.

To read another file, create or edit `~/.paseo/plugin-settings/envelope/settings.json` with `{"version": 1, "values": {"envFile": "~/path/to/.env"}}`. The folder name is the plugin's install id. The path must be absolute or start with `~/`. The change applies at the next session opening, without reloading the plugin. You can also ask an agent to make this change.

## Precedence

A variable already set in the provider's env in Paseo's config, or passed when the agent is created, keeps its value. `PATH`, `HOME`, `SHELL`, `USER` and `PASEO_*` are never injected. The plugin logs only key names, never values.
