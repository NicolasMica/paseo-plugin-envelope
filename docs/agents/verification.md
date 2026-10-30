# Verification in paseo-plugin-envelope

How agents run this repository, check a change and prove it. The `setup-agent-repo` skill writes this file, but it belongs to the repository: keep it current, so a command that changes changes this file with it.

## Run the application

Envelope is a Paseo plugin: it has no server of its own and runs inside the Paseo daemon (Node 24, pinned with Volta in `package.json`).

- Install dependencies with `npm ci`. `.npmrc` sets `ignore-scripts=true`, so run `npm run prepare` once per clone to install the lefthook pre-commit hook. A Paseo worktree runs `npm ci` on creation (`paseo.json`).
- To run a change for real, install the checkout into the local daemon as a directory source: `paseo plugin install <absolute path of the checkout>`, then `paseo plugin ls` must show `envelope` as `running`. Use `paseo plugin reload envelope` after each change and `paseo plugin logs envelope` to read its output. Plugins must be enabled once (Settings → Plugins → Enable plugins). Installing replaces the user's installed Envelope: say so first, and reinstall `github:NicolasMica/paseo-plugin-envelope` afterwards.
- The server side acts when an agent session opens: create one (`paseo run …`) or reload one (`paseo agent reload <agent-id>`) to trigger the hooks. The client side is the settings screen in the Paseo app, under Settings → Plugins → Envelope → Environment.

## Checks

Four gates, run by the pre-commit hook (`lefthook.yml`) on the working tree and by CI (`.github/workflows/ci.yml`, GitHub-hosted `ubuntu-latest`) on the pushed commit; CI is the authority:

```sh
npm run typecheck     # tsc --build over the server, client and client-test projects
npm run lint          # type-aware oxlint; warnings fail
npm run format:check  # oxfmt --check .  (npm run format to fix)
npm test              # vitest run --coverage, 100% thresholds
```

- Coverage must stay at 100% over every source file, tested or not (`vitest.config.ts`). Never lower a threshold, exclude a file or add a suppression to pass a gate (see `AGENTS.md`).
- Run one test file with `npx vitest run server/inject-env.test.ts` (no coverage) and filter by name with `-t "<name>"`. The full `npm test` still has to pass, since coverage is measured over the whole repo.
- `npm run lint:fix`, `npm run format:files <files>` and `npm run format:check:files <files>` work on a subset.

## Proving changes

- Server behavior (hooks, RPCs, parsing, logging): a Vitest test that fails without the change and passes with it, through the public factories (`createEnvelopeHooks`, the RPC handler factories). Log output is part of the contract: tests assert that no key name or value reaches a log line.
- Client behavior (settings screen): Vitest with `test-renderer` and the mocked `@getpaseo/plugin/client` and `/client/ui` modules, as described in `docs/design.md` under Quality gates. These tests do not render real pixels.
- Behavior that depends on the real daemon or a provider (which env a provider's shell or MCP server sees, system prompt delivery): install the checkout as above, create a probe agent, and check a variable by presence only with `[ -n "$NAME" ] && echo set` in its shell. Never print a value or the `.env` file. Record the result and the Paseo and provider versions in the pull request; `docs/design.md` keeps verified constraints.
- Gap: there is no scripted way to capture the settings screen in the real app. A visual change needs a manual check in the Paseo app (desktop or web), with a screenshot attached to the pull request, or a stated limitation when it could not be done.

## Environment

- Tests need nothing beyond `npm ci`: no network, no daemon, no `.env`.
- A live check uses the local Paseo daemon (`~/.paseo`) and a throwaway `.env` with dummy values, readable by its owner only (`chmod 600`), set through the `envFile` setting. Never point it at a real secrets file, and never run the daemon at the `trace` log level while testing, since it logs tool output.
- Restore the user's `envFile` setting and plugin install after a live check.
