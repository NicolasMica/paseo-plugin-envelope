import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import contribute from "../index.server";
import {
  MAX_KEY_LENGTH,
  envVarsList,
  envVarsListSchema,
  envVarsReveal,
  envVarsRevealSchema,
  type EnvVarsList,
  type EnvVarsReveal,
} from "../shared/env-vars";
import {
  createEnvVarsListHandler,
  createEnvVarsRevealHandler,
  type EnvVarsContext,
} from "./env-vars";
import {
  createEnvSource,
  createEnvelopeHooks,
  type EnvSourceOptions,
  type EnvelopeSettingsState,
} from "./inject-env";

// Pass-through by default, so a test can stall one `open` the way a hung mount would.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn<typeof actual.open>(actual.open) };
});

const noop = () => {};
const accepted = () => true;

/** Types a deliberately malformed value or a partial fake as `T`, so a test can reach the runtime guards the types otherwise rule out. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- a return-only `T` is how the caller picks the type to fake
function malformed<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the whole point is to hand the code a value its types forbid
  return value as T;
}

function spyOnOutput() {
  const consoleSpies = Object.keys(console)
    .filter((name): name is keyof Console => typeof Reflect.get(console, name) === "function")
    .map((name) => vi.spyOn(console, name).mockImplementation(noop));
  return [
    ...consoleSpies,
    vi.spyOn(process, "emitWarning").mockImplementation(noop),
    vi.spyOn(process.stdout, "write").mockImplementation(accepted),
    vi.spyOn(process.stderr, "write").mockImplementation(accepted),
  ];
}

/** Values no output may contain. Some are shaped like keys, so a leak can't hide behind a key-like look. */
const SENTINELS = ["s3ntinel-value-1", "SENTINEL_VALUE_2", "sentinel3", "SENTINEL4"] as const;
const SENTINEL_ENV = [
  `A=${SENTINELS[0]}`,
  `PATH=${SENTINELS[1]}`,
  `B="${SENTINELS[2]}"`,
  `PASEO_X=${SENTINELS[3]}`,
].join("\n");

let dir: string;
let spies: ReturnType<typeof spyOnOutput>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "envelope-vars-"));
  spies = spyOnOutput();
});

afterEach(async () => {
  // The handlers never log, on any path.
  const loud = spies.filter((spy) => spy.mock.calls.length > 0).length;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
  if (loud > 0) throw new Error(`${loud} output channels were written to`);
});

const envPath = () => join(dir, "agents.env");

async function writeEnv(content: string) {
  await writeFile(envPath(), content, { mode: 0o600 });
}

function ready(envFile?: string): () => Promise<EnvelopeSettingsState> {
  const values = envFile === undefined ? {} : { envFile };
  return async () => ({ status: "ready", revision: "r1", values });
}

// Mirrors Paseo 0.11.1, where these ids are the built-in providers.
const BUILTIN_SNAPSHOT = {
  entries: ["claude", "codex", "copilot", "opencode", "pi", "omp"].map((provider) => ({
    provider,
    source: "builtin",
  })),
};

type Paseo = EnvVarsContext["paseo"];

function contextWith(
  get: Paseo["config"]["get"],
  snapshot: Paseo["providers"]["snapshot"] = async () => BUILTIN_SNAPSHOT,
): EnvVarsContext {
  return { paseo: { config: { get }, providers: { snapshot } } };
}

function providersContext(providers: unknown = {}) {
  return contextWith(async () => ({ config: { providers } }));
}

function makeSource(options: Partial<EnvSourceOptions> = {}) {
  return createEnvSource({ readSettings: ready(envPath()), homedir: () => dir, ...options });
}

/** Runs the list handler and checks its result against the RPC output schema, as the host does. */
async function list(
  options: Partial<EnvSourceOptions> = {},
  context = providersContext(),
): Promise<EnvVarsList> {
  const result = await createEnvVarsListHandler(makeSource(options))({}, context);
  expect(envVarsListSchema.parse(result)).toEqual(result);
  for (const sentinel of SENTINELS) expect(JSON.stringify(result)).not.toContain(sentinel);
  return result;
}

/** Runs the reveal handler and checks its result against the RPC output schema. */
async function reveal(key: string, options: Partial<EnvSourceOptions> = {}) {
  const result = await createEnvVarsRevealHandler(makeSource(options))({ key });
  expect(envVarsRevealSchema.parse(result)).toEqual(result);
  return result;
}

function failing(code: string) {
  return Object.assign(new Error(`${SENTINELS[0]} ${code}`), { code });
}

describe("contracts", () => {
  it("names the RPCs and bounds the reveal key", () => {
    expect(envVarsList.name).toBe("env-vars.list");
    expect(envVarsList.input.parse({})).toEqual({});
    expect(envVarsReveal.name).toBe("env-vars.reveal");
    expect(envVarsReveal.input.parse({ key: "A" })).toEqual({ key: "A" });
    expect(envVarsReveal.input.safeParse({ key: "" }).success).toBe(false);
    expect(envVarsReveal.input.safeParse({ key: "K".repeat(MAX_KEY_LENGTH) }).success).toBe(true);
    expect(envVarsReveal.input.safeParse({ key: "K".repeat(MAX_KEY_LENGTH + 1) }).success).toBe(
      false,
    );
  });

  it("has no room for a value in the list output", () => {
    const ok = {
      state: "ok",
      path: "/a.env",
      providers: "ok",
      variables: [{ key: "A", status: { kind: "injected", overriddenBy: [] } }],
    };
    expect(envVarsListSchema.safeParse(ok).success).toBe(true);
    expect(envVarsListSchema.safeParse({ ...ok, value: "x" }).success).toBe(false);
    expect(
      envVarsListSchema.safeParse({
        ...ok,
        variables: [{ key: "A", value: "x", status: { kind: "protected" } }],
      }).success,
    ).toBe(false);
    expect(
      envVarsListSchema.safeParse({
        ...ok,
        variables: [{ key: "A", status: { kind: "protected", value: "x" } }],
      }).success,
    ).toBe(false);
    expect(
      envVarsListSchema.safeParse({ state: "missing", path: "/a.env", value: "x" }).success,
    ).toBe(false);
    expect(
      envVarsListSchema.safeParse({ state: "error", path: "/a.env", code: "x=1" }).success,
    ).toBe(false);
  });

  it("never echoes the key in a reveal failure", () => {
    expect(envVarsRevealSchema.safeParse({ state: "not-found", key: "A" }).success).toBe(false);
    expect(envVarsRevealSchema.safeParse({ state: "unavailable", code: "x=1" }).success).toBe(
      false,
    );
  });
});

describe("env-vars.list", () => {
  it("lists every key in file order with its status, and no value", async () => {
    await writeEnv(SENTINEL_ENV);

    expect(await list()).toEqual({
      state: "ok",
      path: envPath(),
      providers: "ok",
      variables: [
        { key: "A", status: { kind: "injected", overriddenBy: [] } },
        { key: "PATH", status: { kind: "protected" } },
        { key: "B", status: { kind: "injected", overriddenBy: [] } },
        { key: "PASEO_X", status: { kind: "protected" } },
      ],
    });
  });

  it("names the providers whose env chain sets a key, following extends like the hook", async () => {
    await writeEnv(`A=${SENTINELS[0]}\nB=${SENTINELS[1]}\nC=${SENTINELS[2]}\nD=${SENTINELS[3]}`);
    const context = providersContext({
      claude: { env: { A: "provider" } },
      // A custom provider inherits its base's env.
      mine: { extends: "claude", env: { B: "provider" } },
      deeper: { extends: "mine" },
      // Paseo ignores `extends` on a built-in provider.
      codex: { extends: "claude", env: { C: "provider" } },
      viaAcp: { extends: "acp" },
      broken: "not an object",
    });

    const result = await list({}, context);

    assert(result.state === "ok");
    expect(result.variables).toEqual([
      { key: "A", status: { kind: "injected", overriddenBy: ["claude", "mine", "deeper"] } },
      { key: "B", status: { kind: "injected", overriddenBy: ["mine", "deeper"] } },
      { key: "C", status: { kind: "injected", overriddenBy: ["codex"] } },
      { key: "D", status: { kind: "injected", overriddenBy: [] } },
    ]);
  });

  it("follows a built-in's extends when the snapshot fails, like the hook", async () => {
    await writeEnv(`A=${SENTINELS[0]}`);
    const context = contextWith(
      async () => ({
        config: { providers: { claude: { env: { A: "1" } }, codex: { extends: "claude" } } },
      }),
      () => {
        throw new Error(SENTINELS[1]);
      },
    );

    const result = await list({}, context);

    assert(result.state === "ok");
    expect(result.providers).toBe("ok");
    expect(result.variables).toEqual([
      { key: "A", status: { kind: "injected", overriddenBy: ["claude", "codex"] } },
    ]);
  });

  it("reports the providers as unavailable when the config can't be read", async () => {
    await writeEnv(SENTINEL_ENV);
    const reject = contextWith(async () => {
      throw new Error(SENTINELS[0]);
    });
    const notRecord = contextWith(async () => ({ config: [SENTINELS[0]] }));

    for (const context of [reject, notRecord]) {
      const result = await list({}, context);
      assert(result.state === "ok");
      expect(result.providers).toBe("unavailable");
      expect(result.variables.map(({ status }) => status)).toEqual([
        { kind: "injected", overriddenBy: [] },
        { kind: "protected" },
        { kind: "injected", overriddenBy: [] },
        { kind: "protected" },
      ]);
    }
  });

  it("times out a stalled config read", async () => {
    await writeEnv(`A=${SENTINELS[0]}`);
    const stalled = contextWith(() => new Promise(noop));

    const result = await list({ configTimeoutMs: 1 }, stalled);

    assert(result.state === "ok");
    expect(result.providers).toBe("unavailable");
  });

  it("treats a config without providers as no override", async () => {
    await writeEnv(`A=${SENTINELS[0]}`);

    const result = await list(
      {},
      contextWith(async () => ({ config: {} })),
    );

    assert(result.state === "ok");
    expect(result).toMatchObject({ providers: "ok" });
    expect(result.variables).toEqual([
      { key: "A", status: { kind: "injected", overriddenBy: [] } },
    ]);
  });

  it("doesn't read the config when every key is protected or the file is empty", async () => {
    const get = vi.fn<Paseo["config"]["get"]>(async () => ({ config: {} }));
    await writeEnv(`PATH=${SENTINELS[0]}`);
    expect(await list({}, contextWith(get))).toMatchObject({
      providers: "ok",
      variables: [{ key: "PATH", status: { kind: "protected" } }],
    });
    await writeEnv("# nothing here\n");
    expect(await list({}, contextWith(get))).toMatchObject({ providers: "ok", variables: [] });
    expect(get).not.toHaveBeenCalled();
  });

  it("re-reads the file on every call", async () => {
    await writeEnv(`A=${SENTINELS[0]}`);
    const handler = createEnvVarsListHandler(makeSource());
    expect(await handler({}, providersContext())).toMatchObject({ variables: [{ key: "A" }] });
    await writeEnv(`B=${SENTINELS[1]}`);
    expect(await handler({}, providersContext())).toMatchObject({ variables: [{ key: "B" }] });
  });

  it("reports settings states without reading anything", async () => {
    expect(await list({ readSettings: ready() })).toEqual({ state: "not-configured" });
    expect(await list({ readSettings: ready("") })).toEqual({ state: "not-configured" });
    expect(await list({ readSettings: ready("relative.env") })).toEqual({ state: "relative" });
    expect(
      await list({
        readSettings: async () => ({ status: "invalid", revision: "r1", error: SENTINELS[0] }),
      }),
    ).toEqual({ state: "invalid-settings" });
    expect(
      await list({
        readSettings: () => {
          throw new Error(SENTINELS[0]);
        },
      }),
    ).toEqual({ state: "settings-unreadable" });
  });

  it("reports an unresolvable path with its code only", async () => {
    const homedir = () => {
      throw failing("ENOENT");
    };
    expect(await list({ readSettings: ready("~/a.env"), homedir })).toEqual({
      state: "unresolved",
      code: "ENOENT",
    });
  });

  it("maps read failures to the file states", async () => {
    const missing = join(dir, "missing.env");
    expect(await list({ readSettings: ready(missing) })).toEqual({
      state: "missing",
      path: missing,
    });
    await writeEnv("");
    const below = join(envPath(), "below.env");
    expect(await list({ readSettings: ready(below) })).toEqual({ state: "missing", path: below });
    const sub = join(dir, "sub");
    await mkdir(sub);
    expect(await list({ readSettings: ready(sub) })).toEqual({ state: "not-file", path: sub });
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", [fifo], { stdio: "ignore" });
    expect(await list({ readSettings: ready(fifo) })).toEqual({ state: "not-file", path: fifo });
  });

  it("reports other read failures with an identifier-shaped code", async () => {
    await writeEnv(SENTINEL_ENV);
    vi.mocked(open).mockRejectedValueOnce(failing("EACCES"));
    expect(await list()).toEqual({ state: "error", path: envPath(), code: "EACCES" });
    vi.mocked(open).mockRejectedValueOnce(failing(`E${SENTINELS[0]}`));
    expect(await list()).toEqual({ state: "error", path: envPath(), code: "UNKNOWN" });
    vi.mocked(open).mockReturnValueOnce(new Promise(noop));
    expect(await list({ readTimeoutMs: 1 })).toEqual({
      state: "error",
      path: envPath(),
      code: "ETIMEDOUT",
    });
  });
});

describe("env-vars.reveal", () => {
  it("returns the value of one key, protected ones included", async () => {
    await writeEnv(SENTINEL_ENV);
    expect(await reveal("A")).toEqual({ state: "ok", value: SENTINELS[0] });
    expect(await reveal("B")).toEqual({ state: "ok", value: SENTINELS[2] });
    expect(await reveal("PATH")).toEqual({ state: "ok", value: SENTINELS[1] });
  });

  it("returns an empty value as a value", async () => {
    await writeEnv("EMPTY=");
    expect(await reveal("EMPTY")).toEqual({ state: "ok", value: "" });
  });

  it("reports a key that is no longer in the file, without echoing it", async () => {
    await writeEnv(SENTINEL_ENV);
    const results = [await reveal("GONE"), await reveal("constructor"), await reveal("toString")];
    expect(results).toEqual([
      { state: "not-found" },
      { state: "not-found" },
      { state: "not-found" },
    ]);
    expect(JSON.stringify(results)).not.toMatch(/GONE|constructor|toString/u);
  });

  it("reads the file at call time", async () => {
    await writeEnv("A=first");
    const handler = createEnvVarsRevealHandler(makeSource());
    expect(await handler({ key: "A" })).toEqual({ state: "ok", value: "first" });
    await writeEnv("A=second");
    expect(await handler({ key: "A" })).toEqual({ state: "ok", value: "second" });
    await writeEnv("B=other");
    expect(await handler({ key: "A" })).toEqual({ state: "not-found" });
  });

  it("is unavailable when the settings or the file can't be used, with at most a code", async () => {
    const results: EnvVarsReveal[] = [
      await reveal("A", { readSettings: ready() }),
      await reveal("A", { readSettings: ready("relative.env") }),
      await reveal("A", {
        readSettings: async () => ({ status: "invalid", revision: "r1", error: SENTINELS[0] }),
      }),
      await reveal("A", {
        readSettings: async () => {
          throw new Error(SENTINELS[0]);
        },
      }),
    ];
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ state: "unavailable" })));

    expect(await reveal("A", { readSettings: ready(join(dir, "missing.env")) })).toEqual({
      state: "unavailable",
      code: "ENOENT",
    });
    const homedir = () => {
      throw failing(`E${SENTINELS[0]}`);
    };
    expect(await reveal("A", { readSettings: ready("~/a.env"), homedir })).toEqual({
      state: "unavailable",
      code: "UNKNOWN",
    });
  });
});

describe("shared source", () => {
  function makeSessionRequest(): PluginSessionOpenRequest {
    return {
      agentId: "agent-1",
      workspaceId: "ws-1",
      provider: "claude",
      cwd: "/work",
      reason: "resume",
      purpose: "interactive",
      env: {},
    };
  }

  it("shares one stalled read between the hooks and both RPCs", async () => {
    await writeEnv(`A=${SENTINELS[0]}`);
    let release: (handle: FileHandle) => void = noop;
    vi.mocked(open).mockReturnValueOnce(
      new Promise<FileHandle>((resolve) => {
        release = resolve;
      }),
    );
    const source = makeSource();
    const lines: string[] = [];
    const hooks = createEnvelopeHooks({
      source,
      log: (line) => {
        lines.push(line);
      },
      warn: noop,
    });
    const context = { ...providersContext(), signal: new AbortController().signal };

    const opened = hooks.sessionOpen({ request: makeSessionRequest() }, context);
    const listed = createEnvVarsListHandler(source)({}, context);
    const revealed = createEnvVarsRevealHandler(source)({ key: "A" });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    release(await actual.open(envPath()));

    expect((await opened).env).toEqual({ A: SENTINELS[0] });
    expect(await listed).toMatchObject({ state: "ok", variables: [{ key: "A" }] });
    expect(await revealed).toEqual({ state: "ok", value: SENTINELS[0] });
    expect(open).toHaveBeenCalledOnce();
    expect(lines).toEqual(["agent-1 (resume) injected 1"]);
  });

  it("registers both RPCs on the source the hooks use", async () => {
    await writeEnv(`A=${SENTINELS[0]}`);
    const handle = vi.fn<(contract: { name: string }, handler: unknown) => void>();
    const before = vi.fn<(event: string, hook: unknown) => () => void>(() => noop);
    const server = malformed<Parameters<typeof contribute>[0]>({
      before,
      handle,
      registerSettings: () => ({ read: ready(envPath()), subscribe: () => noop }),
    });

    contribute(server);

    const handlers = new Map(
      handle.mock.calls.map(([contract, handler]) => [contract.name, handler]),
    );
    const listHandler = malformed<ReturnType<typeof createEnvVarsListHandler>>(
      handlers.get("env-vars.list"),
    );
    const revealHandler = malformed<ReturnType<typeof createEnvVarsRevealHandler>>(
      handlers.get("env-vars.reveal"),
    );
    let release: (handle: FileHandle) => void = noop;
    vi.mocked(open).mockReturnValueOnce(
      new Promise<FileHandle>((resolve) => {
        release = resolve;
      }),
    );
    const sessionOpen = malformed<ReturnType<typeof createEnvelopeHooks>["sessionOpen"]>(
      before.mock.calls.find(([event]) => event === "agent.session_open")?.[1],
    );
    const context = { ...providersContext(), signal: new AbortController().signal };

    const opened = sessionOpen({ request: makeSessionRequest() }, context);
    const listed = listHandler({}, providersContext());
    const revealed = revealHandler({ key: "A" });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    release(await actual.open(envPath()));

    expect(await listed).toMatchObject({ state: "ok", variables: [{ key: "A" }] });
    expect(await revealed).toEqual({ state: "ok", value: SENTINELS[0] });
    expect((await opened).env).toEqual({ A: SENTINELS[0] });
    expect(open).toHaveBeenCalledOnce();
    // The only output is the hook's own count line; the handlers print nothing.
    expect(vi.mocked(console.log).mock.calls).toEqual([["agent-1 (resume) injected 1"]]);
    for (const spy of spies) spy.mockClear();
  });
});
