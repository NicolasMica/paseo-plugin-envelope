# Envelope

Envelope is a [Paseo](https://paseo.sh) plugin that hands the variables of one global `.env` file to every agent session when it opens, whether the session is created, resumed, refreshed or imported. Agents get the variables in their process environment, so their shell commands see them without any shell setup.

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

To update, run `paseo plugin update envelope`. It shows the available update and asks before applying it. To remove the plugin, run `paseo plugin remove envelope`. Removing or disabling it doesn't touch your `.env`, and agents that are already running keep the variables they received until their next session opening.

## Write the `.env`

Envelope reads `$XDG_CONFIG_HOME/paseo-plugin-envelope/.env`, or `~/.config/paseo-plugin-envelope/.env` when `XDG_CONFIG_HOME` is unset, empty or not an absolute path. `XDG_CONFIG_HOME` is read from the daemon's environment: a value set only in your interactive shell is ignored.

Create the file and make it readable by you only:

```sh
mkdir -p ~/.config/paseo-plugin-envelope
touch ~/.config/paseo-plugin-envelope/.env
chmod 600 ~/.config/paseo-plugin-envelope/.env
```

Then edit it with your editor. Avoid writing values with `echo` on the command line, which stores them in your shell history.

The file is parsed with [dotenv](https://github.com/motdotla/dotenv)'s `parse`, with these rules:

- One assignment per line: `KEY=value`, `export KEY=value` or `KEY: value` (with a space after the colon). Spaces around the key and the `=` are ignored.
- Keys use letters, digits, `_`, `.` and `-`.
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

## When variables apply

Envelope reads the file again every time an agent session opens: on create, resume, refresh and import. If the file is missing, it does nothing.

An agent that is already running keeps the environment it started with. After you change the `.env`, reload the agent so its session opens again:

```sh
paseo agent reload <agent-id>
```

This restarts the agent's process and interrupts its current turn if it has one.

## Precedence

A `.env` variable is injected only when nothing more explicit sets it:

- **Provider env wins.** A key set in `agents.providers.<provider>.env` of the daemon's `config.json` is not injected from the `.env`. This includes the env of the providers that a custom provider `extends`.
- **`paseo run --env` wins at create only.** A key passed with `paseo run --env` wins when the agent is created. Paseo doesn't keep it, so on the next resume or refresh the `.env` value applies.
- **The `.env` wins over the daemon's inherited environment.** If the daemon process already has a variable and the `.env` sets it too, the agent gets the `.env` value.
- **Protected variables are never injected:** `PATH`, `HOME`, `SHELL`, `USER` and every key starting with `PASEO_`. Envelope skips them and logs their names.
- **If Envelope can't read the daemon config,** it injects nothing for that session rather than risk overwriting a provider's env.

## Security

- **Every agent sees every variable.** There is no per-project, per-provider or per-agent scope. An agent can print a value in its transcript, in command output, or pass it to a tool.
- **Values stay in plain text** in the `.env`. Keep it at `chmod 600`: Envelope logs a warning when the file is readable by group or others.
- **Envelope only logs names.** Its output contains agent ids, session reasons, variable names, the file path, error codes and error names, never a value.
- **Don't run the daemon at the `trace` log level while agents handle secrets.** At `trace`, Paseo logs raw provider events, including tool output, so a value an agent prints lands in `daemon.log`. The default `info` level doesn't log the injected environment.
- **On OpenCode,** any injected variable makes Paseo start a dedicated OpenCode server for the session instead of the shared one.

## Troubleshooting

Show Envelope's recent output:

```sh
paseo plugin logs envelope
```

The same output is under Settings → Plugins → Logs. The lines it can contain:

| Line                                                   | Meaning                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `<agent-id> (<reason>) NAME_1, NAME_2`                 | These variables were injected when the session opened.                                                                 |
| `<agent-id> (<reason>) skipped protected PATH`         | The `.env` sets a protected variable, which was not injected.                                                          |
| `<path> is readable by group or others, run chmod 600` | The file permissions are too open.                                                                                     |
| `read failed: EACCES`                                  | The file exists but can't be read. The code tells why (`EACCES`, `EISDIR`…). Nothing was injected.                     |
| `config read failed: <ErrorName>`                      | Envelope couldn't read the daemon config, or the read took more than 5 seconds. Nothing was injected for that session. |
| `unexpected error: <ErrorName>`                        | Something else failed. Nothing was injected, and the agent started normally.                                           |

No line at all for a session means the file is missing or empty, or every variable in it is already set by the provider env or the create request. A variable missing from an agent can also come from a typo in the `.env`: dotenv skips malformed lines silently.

Envelope never blocks an agent from starting: on any error, the session opens without the `.env` variables.

Use these logs to see which names an agent received. Don't debug by printing the file, or by running `env` or `printenv` in an agent's shell: that puts the values in the agent's transcript.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
```

The design and its decisions are in [`docs/design.md`](docs/design.md).
