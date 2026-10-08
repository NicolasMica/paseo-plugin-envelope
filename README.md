# Envelope

Envelope is a [Paseo](https://paseo.sh) plugin that hands the variables of one `.env` file to every agent session when it opens, whether the session is created, resumed, refreshed or imported. Agents get the variables in their process environment, so their shell commands see them without any shell setup.

Every agent of every provider receives the whole file. Agents can read, print or send these values anywhere, so only put in the file what every agent may see.

## Before you install

Paseo plugins are trusted code that runs unsandboxed in the daemon, with access to your files, processes, credentials and network. Read [`index.server.ts`](index.server.ts) and [`server/`](server/) before installing Envelope.

Requirements:

- Paseo 0.11.0 or later on the daemon machine.
- `npm` on the daemon's `PATH`. On install and update, Paseo runs `npm ci --omit=dev --ignore-scripts` in the plugin checkout to install its one runtime dependency, `dotenv`, from the committed lockfile.
- Access to this private repository from the daemon machine. Paseo clones `github:` sources over HTTPS with Git's terminal prompt disabled, so Git needs stored GitHub credentials, for example from `gh auth setup-git`.

## Install

1. Enable plugins on the daemon, once. In the app, use Settings → Plugins → Enable plugins. Or set `"pluginsEnabled": true` at the root of the daemon's `config.json` (`~/.paseo/config.json` by default) and run `paseo reload`.
2. Install the plugin:

   ```sh
   paseo plugin install github:NicolasMica/paseo-plugin-envelope
   ```

3. Check that `envelope` is `running`:

   ```sh
   paseo plugin ls
   ```

To update, run `paseo plugin update envelope`. It shows the available update and asks before applying it. To remove the plugin, run `paseo plugin remove envelope`. Removing it also deletes its settings (see [Use another file](#use-another-file)) but not your `.env`. After removing or disabling it, agents that are already running keep the variables they received until their next session opening.

## Write the `.env`

By default, Envelope reads `$XDG_CONFIG_HOME/paseo-plugin-envelope/.env`, or `~/.config/paseo-plugin-envelope/.env` when `XDG_CONFIG_HOME` is unset, empty or not an absolute path. `XDG_CONFIG_HOME` is read from the daemon's environment. The desktop app loads your login shell's environment when it starts, and a daemon started from a terminal inherits that terminal's, so an `XDG_CONFIG_HOME` exported in your shell profile usually applies. A change to it only applies once the daemon has restarted.

Create the directory and the file, readable by you only:

```sh
dir="${XDG_CONFIG_HOME:-$HOME/.config}/paseo-plugin-envelope"
mkdir -p "$dir" && chmod 700 "$dir"
touch "$dir/.env" && chmod 600 "$dir/.env"
```

The directory mode also protects the swap and backup files some editors write next to the file, which Envelope doesn't check. Some editors save by replacing the file, which can reset its mode: Envelope warns in its logs when that happens.

Then edit it with your editor. Avoid writing values with `echo` on the command line, which stores them in your shell history.

The file is parsed with [dotenv](https://github.com/motdotla/dotenv)'s `parse`, with these rules:

- One assignment per line: `KEY=value`, `export KEY=value` or `KEY: value` (with a space after the colon). Spaces around the key and the `=` are ignored.
- Keys use ASCII letters, digits, `_`, `.` and `-`.
- Empty lines and lines starting with `#` are ignored.
- In an unquoted value, `#` starts a comment even without a space before it, and trailing spaces are trimmed. Quote any value that contains `#`.
- Single quotes, double quotes and backticks are all quotes, and quoted values can span several lines. Only double quotes expand `\n` and `\r`. Single quotes and backticks keep the content as it is.
- No `$VAR` interpolation and no command substitution: `$HOME` or `$(cmd)` stay literal text.
- If a key appears twice, the last value wins.
- Lines that aren't an assignment are skipped silently, with no warning and no line number.
- A broken quote is not skipped: `KEY="abc` with no closing quote, or `KEY="abc" junk`, gives the raw text, quotes included.

Example:

```sh
# Notion
NOTION_TOKEN_V2='value with # inside'
export OPENAI_API_KEY=value
```

### Use another file

To read another file, set `envFile` in the plugin settings. Create or edit `~/.paseo/plugin-settings/envelope/settings.json` (`<paseo home>/plugin-settings/<plugin id>/settings.json` if you changed the Paseo home or installed with `--id`):

```json
{ "version": 1, "values": { "envFile": "~/secrets/agents.env" } }
```

- The path must be absolute or start with `~/`, where `~` is the home directory of the daemon's user. Any other value makes Envelope warn and inject nothing, rather than fall back to the default file.
- An empty or missing `envFile` uses the default path.
- Unlike the default file, a configured file that doesn't exist gets a warning in the logs.
- The setting is read again at every session opening, so a change applies at the next one, without reloading the plugin. There is no settings screen in the app yet.
- If the settings file isn't valid JSON or doesn't match this shape, Envelope warns and injects nothing.

## When variables apply

Envelope reads its settings and the file again every time an agent session opens: on create, resume, refresh and import. If the default file is missing, it does nothing.

An agent that is already running keeps the environment it started with. After you change the `.env` or the `envFile` setting, reload the agent so its session opens again:

```sh
paseo agent reload <agent-id>
```

This restarts the agent's process and interrupts its current turn if it has one.

## Precedence

A `.env` variable is injected only when nothing more explicit sets it:

- **Provider env wins.** A key set in `agents.providers.<provider>.env` of the daemon's `config.json` is not injected from the `.env`. This includes the env of the providers that a custom provider `extends`.
- **`paseo run --env` wins at create only.** A key passed with `paseo run --env` wins when the agent is created. Paseo doesn't keep it, so on the next resume or refresh the `.env` value applies. A secret passed this way also ends up in your shell history.
- **The `.env` wins over the daemon's inherited environment.** If the daemon process already has a variable and the `.env` sets it too, the agent gets the `.env` value.
- **Protected variables are never injected:** `PATH`, `HOME`, `SHELL`, `USER` and every key starting with `PASEO_`. Envelope skips them and counts them in its logs.
- **If Envelope can't read the daemon config** within 5 seconds, it injects nothing for that session rather than risk overwriting a provider's env.

## Security

- **Every agent sees every variable.** There is no per-project, per-provider or per-agent scope. An agent can print a value in its transcript, in command output, or pass it to a tool. Providers keep transcripts on disk, so a printed value stays there after the session ends.
- **Values stay in plain text** in the `.env`. Keep it at `chmod 600` in a `chmod 700` directory. On macOS and Linux, Envelope logs a warning when the file is readable by group or others, once until the file or its mode changes.
- **Envelope logs counts, not names.** Its output contains agent ids, session reasons, counts, the file path, error codes and error names, never a variable name or a value. A malformed line can turn part of a value into a key, so even names could leak a value.
- **Don't run the daemon at the `trace` log level while agents handle secrets.** At `trace`, Paseo logs raw provider events, including tool output, so a value an agent prints lands in `daemon.log`. The default `info` level doesn't log the injected environment.
- **Only regular files are read.** A FIFO, a socket or a directory at the file's path is refused with a warning, so it can't hang the session opening.
- **On OpenCode,** any injected variable makes Paseo start a dedicated OpenCode server for the session instead of the shared one.

## Troubleshooting

Show Envelope's recent output:

```sh
paseo plugin logs envelope
```

The same output is under Settings → Plugins → Logs.

Each session opening where the file has at least one variable logs one line:

```text
<agent-id> (<reason>) injected N, skipped M protected, K already set
```

`N` variables were injected. `M` were protected variables. `K` were already set by the provider env or the create request, so they kept their value. The last two parts only appear when they aren't zero.

The other lines are warnings. They carry no agent id, so match them to a session by time.

| Warning                                                | Meaning                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<path> is readable by group or others, run chmod 600` | The file permissions are too open. Logged once until the file or its mode changes.                                                                      |
| `read failed: <CODE>`                                  | The file can't be read. `ENOENT` means a configured `envFile` doesn't exist. `EISDIR` and `ENOTREG` mean it isn't a regular file. Nothing was injected. |
| `envFile setting is not an absolute path`              | Fix `envFile` in the settings. Nothing was injected.                                                                                                    |
| `settings invalid`                                     | The settings file isn't valid JSON or doesn't match the expected shape. Nothing was injected.                                                           |
| `settings read failed: <ErrorName>`                    | The settings couldn't be read. Nothing was injected.                                                                                                    |
| `config read failed: <ErrorName>`                      | Envelope couldn't read the daemon config, or the read took more than 5 seconds. Nothing was injected.                                                   |
| `provider snapshot failed: <ErrorName>`                | Envelope couldn't list the built-in providers. It still injects, but follows every `extends`, so it can only skip more variables.                       |
| `unexpected error: <ErrorName>`                        | Something else failed. Nothing was injected, and the agent started normally.                                                                            |

No line at all for a session means one of these:

- Envelope isn't running: check that `paseo plugin ls` shows `envelope` as `running`, and that plugins are enabled.
- The default file is missing, or isn't where the daemon looks (see [Write the `.env`](#write-the-env)).
- The file has no valid assignment.

A variable missing from an agent can also come from a typo in the `.env`: dotenv skips malformed lines silently.

When Envelope hits an error it catches, the session opens without the `.env` variables instead of failing.

The logs never say which variables an agent received. To check one without printing its value, run `[ -n "$NAME" ] && echo set` in the agent's shell. Don't debug by printing the file, or by running `env`, `printenv` or `echo "$NAME"` in an agent's shell: that puts the values in the agent's transcript.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
```

The design and its decisions are in [`docs/design.md`](docs/design.md).
