import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SECRETS_GUIDELINE, SECRETS_GUIDELINE_HEADING } from "./guideline";
import { createEnvelopeHooks, type InjectEnvContext, type InjectEnvOptions } from "./inject-env";

// Pass-through by default, so a test can stall one `open`.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn<typeof actual.open>(actual.open) };
});

type CreateRequest = PluginBeforeRequests["agent.create"];
type Get = InjectEnvContext["paseo"]["config"]["get"];
type Snapshot = InjectEnvContext["paseo"]["providers"]["snapshot"];

const noop = () => {};
const accepted = () => true;
const BUILTIN_SNAPSHOT = {
  entries: ["claude", "codex", "copilot", "opencode", "pi", "omp"].map((provider) => ({
    provider,
    source: "builtin",
  })),
};

let xdg: string;
let output: string[];

beforeEach(async () => {
  xdg = await mkdtemp(join(tmpdir(), "envelope-create-"));
  output = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(xdg, { recursive: true, force: true });
});

function envPath() {
  return join(xdg, "paseo-plugin-envelope", ".env");
}

async function writeEnv(content: string, mode = 0o600) {
  await mkdir(join(xdg, "paseo-plugin-envelope"), { recursive: true });
  await writeFile(envPath(), content);
  await chmod(envPath(), mode);
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

function makeHooks(options: Partial<InjectEnvOptions> = {}) {
  return createEnvelopeHooks({
    readSettings: async () => ({ status: "ready", revision: "r", values: { envFile: envPath() } }),
    log: (line) => {
      output.push(`log: ${line}`);
    },
    warn: (line) => {
      output.push(`warn: ${line}`);
    },
    platform: "darwin",
    ...options,
  });
}

function makeRequest(config: Partial<CreateRequest["config"]> = {}, env?: Record<string, string>) {
  const request: CreateRequest = { config: { provider: "claude", cwd: "/work", ...config } };
  if (env !== undefined) request.env = env;
  return request;
}

function contextWith(
  get: Get,
  snapshot: Snapshot = async () => BUILTIN_SNAPSHOT,
): InjectEnvContext {
  return {
    paseo: { config: { get }, providers: { snapshot } },
    signal: new AbortController().signal,
  };
}

function makeContext(providers: unknown = {}) {
  const get = vi.fn<Get>(async () => ({ config: { providers } }));
  return { context: contextWith(get), get };
}

async function create(
  request = makeRequest(),
  providers: unknown = {},
  options: Partial<InjectEnvOptions> = {},
) {
  const { context, get } = makeContext(providers);
  const result = await makeHooks(options).agentCreate({ request }, context);
  return { request, result, get };
}

function makeSessionRequest() {
  return {
    agentId: "agent-1",
    workspaceId: "ws-1",
    provider: "claude",
    cwd: "/work",
    reason: "create" as const,
    purpose: "interactive" as const,
    env: {},
  };
}

describe("secrets guideline text", () => {
  it("is the documented text and names no variable", () => {
    expect(SECRETS_GUIDELINE_HEADING).toBe("## Environment secrets");
    expect(
      SECRETS_GUIDELINE.startsWith(`${SECRETS_GUIDELINE_HEADING}\n\nYour environment holds`),
    ).toBe(true);
    expect(SECRETS_GUIDELINE).toContain('[ -n "$NAME" ] && echo set');
    expect(SECRETS_GUIDELINE).not.toMatch(/\$(?!NAME\b)[A-Z_]/u);
  });
});

describe("appending the guideline", () => {
  it("sets the guideline as the prompt when the agent has none, and keeps the other fields", async () => {
    await writeEnv("A=1");
    const request = makeRequest({ model: "m", mcpServers: {} });

    const { result } = await create(request);

    expect(result).toEqual({ config: { ...request.config, systemPrompt: SECRETS_GUIDELINE } });
    expect(Object.hasOwn(result, "env")).toBe(false);
    expect(request.config.systemPrompt).toBeUndefined();
    expect(output).toEqual([]);
  });

  it.each(["", "  \n\t"])("replaces a blank prompt (%j) with the guideline", async (prompt) => {
    await writeEnv("A=1");

    const { result } = await create(makeRequest({ systemPrompt: prompt }));

    expect(result.config.systemPrompt).toBe(SECRETS_GUIDELINE);
  });

  it("keeps the existing prompt first", async () => {
    await writeEnv("A=1");
    const request = makeRequest({ systemPrompt: "Be terse." }, { OTHER: "x" });

    const { result } = await create(request);

    expect(result).toEqual({
      config: { ...request.config, systemPrompt: `Be terse.\n\n${SECRETS_GUIDELINE}` },
      env: { OTHER: "x" },
    });
    expect(request.config.systemPrompt).toBe("Be terse.");
  });

  it("appends when the provider env only sets some keys", async () => {
    await writeEnv("A=1\nB=2\nPATH=/x");

    const { result } = await create(makeRequest(), { claude: { env: { A: "0", C: "0" } } });

    expect(result.config.systemPrompt).toBe(SECRETS_GUIDELINE);
  });

  it("appends even when the create env sets every key, since a resume drops it and injects the .env", async () => {
    await writeEnv("A=1\nB=2");
    const request = makeRequest({}, { A: "0", B: "0" });

    const { result, get } = await create(request);

    expect(result).toEqual({
      config: { ...request.config, systemPrompt: SECRETS_GUIDELINE },
      env: { A: "0", B: "0" },
    });
    expect(get).toHaveBeenCalledOnce();
    expect(output).toEqual([]);
  });

  it.each([
    "See the Environment secrets section.",
    "Read ## Environment secrets below.",
    "### Environment secrets",
    "## Environment secrets and more",
  ])("appends when the prompt only mentions the heading: %j", async (prompt) => {
    await writeEnv("A=1");

    const { result } = await create(makeRequest({ systemPrompt: prompt }));

    expect(result.config.systemPrompt).toBe(`${prompt}\n\n${SECRETS_GUIDELINE}`);
  });

  it("reads the env of the config's provider, not another one", async () => {
    await writeEnv("A=1");

    const { result } = await create(makeRequest({ provider: "codex" }), {
      claude: { env: { A: "0" } },
    });

    expect(result.config.systemPrompt).toBe(SECRETS_GUIDELINE);
  });

  it("still appends, silently, when the provider snapshot fails", async () => {
    await writeEnv("A=1");
    const snapshot = async () => {
      throw new Error("boom");
    };
    const context = contextWith(async () => ({ config: { providers: {} } }), snapshot);

    const result = await makeHooks().agentCreate({ request: makeRequest() }, context);

    expect(result.config.systemPrompt).toBe(SECRETS_GUIDELINE);
    expect(output).toEqual([]);
  });
});

describe("not appending the guideline", () => {
  it.each([
    ["an empty envFile", { envFile: "" }],
    ["no envFile", {}],
  ])(
    "does nothing and reads nothing for %s, even with a file at the old default path",
    async (_label, values) => {
      await writeEnv("A=1");
      await mkdir(join(xdg, ".config", "paseo-plugin-envelope"), { recursive: true });
      await writeFile(join(xdg, ".config", "paseo-plugin-envelope", ".env"), "A=1", {
        mode: 0o600,
      });

      const { request, result, get } = await create(
        makeRequest(),
        {},
        {
          readSettings: async () => ({ status: "ready", revision: "r", values }),
          homedir: () => xdg,
        },
      );

      expect(result).toBe(request);
      expect(open).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(output).toEqual([]);
    },
  );

  it("does nothing when the file is empty", async () => {
    await writeEnv("");

    const { request, result } = await create();

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("does nothing without reading the config when the file only has protected keys", async () => {
    await writeEnv("PATH=/x\nPASEO_X=1");

    const { request, result, get } = await create();

    expect(result).toBe(request);
    expect(get).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });

  it("does nothing when the provider env sets every key", async () => {
    await writeEnv("A=1");

    const { request, result } = await create(makeRequest(), { claude: { env: { A: "0" } } });

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("does nothing when the providers it extends set every key", async () => {
    await writeEnv("A=1\nB=2");

    const { request, result } = await create(makeRequest({ provider: "mine" }), {
      mine: { extends: "base", env: { A: "0" } },
      base: { env: { B: "0" } },
    });

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("does nothing, silently, when config.get fails", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = async () => {
      throw new Error("boom");
    };

    const result = await makeHooks().agentCreate({ request }, contextWith(get));

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("does nothing, silently, when config.get times out", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = () => new Promise<never>(noop);

    const result = await makeHooks({ configTimeoutMs: 10 }).agentCreate(
      { request },
      contextWith(get),
    );

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("returns the request unchanged, silently, on an unexpected error", async () => {
    await writeEnv("A=1");
    const request = makeRequest();

    const result = await makeHooks().agentCreate(
      { request },
      contextWith(async () => ({ config: null })),
    );

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("does nothing, silently, when the settings are invalid", async () => {
    await writeEnv("A=1");

    const { request, result } = await create(
      makeRequest(),
      {},
      {
        readSettings: async () => ({ status: "invalid", revision: "r", error: "A=1" }),
      },
    );

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("does nothing, silently, when reading the settings fails", async () => {
    await writeEnv("A=1");

    const { request, result } = await create(
      makeRequest(),
      {},
      {
        readSettings: async () => {
          throw new Error("boom");
        },
      },
    );

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("does nothing, silently, when envFile is relative", async () => {
    await writeEnv("A=1");

    const { request, result } = await create(
      makeRequest(),
      {},
      {
        readSettings: async () => ({
          status: "ready",
          revision: "r",
          values: { envFile: "a.env" },
        }),
      },
    );

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("does nothing, silently, when the configured file is missing", async () => {
    const envFile = join(xdg, "missing.env");

    const { request, result } = await create(
      makeRequest(),
      {},
      {
        readSettings: async () => ({ status: "ready", revision: "r", values: { envFile } }),
      },
    );

    expect(result).toBe(request);
    expect(output).toEqual([]);
  });

  it("does not append twice, nor read anything, when the prompt already has the guideline", async () => {
    await writeEnv("A=1");
    const request = makeRequest({ systemPrompt: `Be terse.\n\n${SECRETS_GUIDELINE}` });

    const { result, get } = await create(request);

    expect(result).toBe(request);
    expect(open).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    "Be terse.\n\n## Environment secrets\n\nAn older wording of the guideline.",
    "Be terse.\r\n  ## Environment secrets  \r\nOlder wording.",
    "## Environment secrets",
  ])("does not append again under an existing heading line: %j", async (prompt) => {
    await writeEnv("A=1");
    const request = makeRequest({ systemPrompt: prompt });

    const { result, get } = await create(request);

    expect(result).toBe(request);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("sharing with the session opening", () => {
  it("stays silent on a group-readable file and leaves the single warning to the session opening", async () => {
    const spies = spyOnOutput();
    await writeEnv("A=1", 0o644);
    const hooks = makeHooks();
    const { context } = makeContext();

    const created = await hooks.agentCreate({ request: makeRequest() }, context);
    expect(created.config.systemPrompt).toBe(SECRETS_GUIDELINE);
    expect(output).toEqual([]);

    await hooks.sessionOpen({ request: makeSessionRequest() }, context);
    await hooks.agentCreate({ request: makeRequest() }, context);
    await hooks.sessionOpen({ request: makeSessionRequest() }, context);

    expect(output).toEqual([
      `warn: ${envPath()} is readable by group or others, run chmod 600`,
      "log: agent-1 (create) injected 1",
      "log: agent-1 (create) injected 1",
    ]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("shares a stalled read with the session opening", async () => {
    await writeEnv("A=1");
    let release: (handle: FileHandle) => void = noop;
    vi.mocked(open).mockReturnValueOnce(
      new Promise<FileHandle>((resolve) => {
        release = resolve;
      }),
    );
    const hooks = makeHooks();
    const { context } = makeContext();

    const created = hooks.agentCreate({ request: makeRequest() }, context);
    const opened = hooks.sessionOpen({ request: makeSessionRequest() }, context);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    release(await actual.open(envPath()));

    expect((await created).config.systemPrompt).toBe(SECRETS_GUIDELINE);
    expect((await opened).env).toEqual({ A: "1" });
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("secrecy", () => {
  it("never puts a key name or a value in its output or in the prompt", async () => {
    const spies = spyOnOutput();
    await writeEnv("S3CR3T_KEY=s3cr3t-value\nghp_s3cr3tTOKEN=", 0o644);

    const { result } = await create(makeRequest({ systemPrompt: "Be terse." }));

    expect(result.config.systemPrompt).toBe(`Be terse.\n\n${SECRETS_GUIDELINE}`);
    expect(SECRETS_GUIDELINE).not.toMatch(/s3cr3t/iu);
    expect(output).toEqual([]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
