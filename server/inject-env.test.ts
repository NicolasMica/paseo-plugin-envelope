import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import contribute from "../index.server";
import {
  createSessionOpenHook,
  envFilePath,
  type InjectEnvContext,
  type InjectEnvOptions,
} from "./inject-env";

const noop = () => {};
const accepted = () => true;

function spyOnOutput() {
  const consoleSpies = Object.keys(console)
    .filter((name) => typeof console[name as keyof Console] === "function")
    .map((name) => vi.spyOn(console, name as keyof Console).mockImplementation(noop));
  return [
    ...consoleSpies,
    vi.spyOn(process, "emitWarning").mockImplementation(noop),
    vi.spyOn(process.stdout, "write").mockImplementation(accepted),
    vi.spyOn(process.stderr, "write").mockImplementation(accepted),
  ];
}

let xdg: string;
let lines: string[];
let warnings: string[];

beforeEach(async () => {
  xdg = await mkdtemp(join(tmpdir(), "envelope-"));
  lines = [];
  warnings = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await chmod(join(xdg, "paseo-plugin-envelope", ".env"), 0o600).catch(noop);
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

function makeHook(options: InjectEnvOptions = {}) {
  return createSessionOpenHook({
    env: { XDG_CONFIG_HOME: xdg },
    log: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    platform: "darwin",
    ...options,
  });
}

function makeRequest(overrides: Partial<PluginSessionOpenRequest> = {}): PluginSessionOpenRequest {
  return {
    agentId: "agent-1",
    workspaceId: "ws-1",
    provider: "claude",
    cwd: "/work",
    reason: "create",
    purpose: "interactive",
    env: {},
    ...overrides,
  };
}

function makeContext(providers: unknown = {}, signal = new AbortController().signal) {
  const get = vi.fn(async () => ({ requestId: "r", config: { providers } as unknown }));
  const context: InjectEnvContext = { paseo: { config: { get } }, signal };
  return { context, get };
}

async function run(content: string, providers: unknown = {}, request = makeRequest()) {
  await writeEnv(content);
  const { context, get } = makeContext(providers);
  const result = await makeHook()({ request }, context);
  return { result, get };
}

describe("path resolution", () => {
  const home = () => "/home/me";

  it("uses an absolute XDG_CONFIG_HOME", () => {
    expect(envFilePath({ XDG_CONFIG_HOME: "/xdg" }, home)).toBe("/xdg/paseo-plugin-envelope/.env");
  });

  it("ignores a relative XDG_CONFIG_HOME", () => {
    expect(envFilePath({ XDG_CONFIG_HOME: "rel/xdg" }, home)).toBe(
      "/home/me/.config/paseo-plugin-envelope/.env",
    );
  });

  it("ignores an empty XDG_CONFIG_HOME", () => {
    expect(envFilePath({ XDG_CONFIG_HOME: "" }, home)).toBe(
      "/home/me/.config/paseo-plugin-envelope/.env",
    );
  });

  it("falls back to the home directory", () => {
    expect(envFilePath({}, home)).toBe("/home/me/.config/paseo-plugin-envelope/.env");
  });

  it("resolves the path on every call", async () => {
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: join(xdg, "missing") };
    const hook = makeHook({ env });
    const { context } = makeContext();
    await writeEnv("A=1");

    const before = await hook({ request: makeRequest() }, context);
    env.XDG_CONFIG_HOME = xdg;
    const after = await hook({ request: makeRequest() }, context);

    expect(before.env).toEqual({});
    expect(after.env).toEqual({ A: "1" });
  });

  it("reads from the home fallback", async () => {
    const hook = makeHook({ env: {}, homedir: () => xdg });
    await mkdir(join(xdg, ".config", "paseo-plugin-envelope"), { recursive: true });
    await writeFile(join(xdg, ".config", "paseo-plugin-envelope", ".env"), "A=1", { mode: 0o600 });

    const result = await hook({ request: makeRequest() }, makeContext().context);

    expect(result.env).toEqual({ A: "1" });
  });
});

describe("reading the file", () => {
  it("does nothing and logs nothing when the file is missing", async () => {
    const request = makeRequest();
    const { context, get } = makeContext();

    const result = await makeHook()({ request }, context);

    expect(result).toBe(request);
    expect(get).not.toHaveBeenCalled();
    expect([...lines, ...warnings]).toEqual([]);
  });

  it("treats ENOTDIR like a missing file", async () => {
    await writeFile(join(xdg, "paseo-plugin-envelope"), "not a dir");
    const request = makeRequest();

    const result = await makeHook()({ request }, makeContext().context);

    expect(result).toBe(request);
    expect([...lines, ...warnings]).toEqual([]);
  });

  it("re-reads the file on every call", async () => {
    const hook = makeHook();
    const { context } = makeContext();
    await writeEnv("A=1");
    const first = await hook({ request: makeRequest() }, context);
    await writeEnv("A=2");
    const second = await hook({ request: makeRequest({ reason: "resume" }) }, context);

    expect(first.env).toEqual({ A: "1" });
    expect(second.env).toEqual({ A: "2" });
  });

  it("logs EISDIR when the path is a directory", async () => {
    await mkdir(envPath(), { recursive: true });
    const request = makeRequest();

    const result = await makeHook()({ request }, makeContext().context);

    expect(result).toBe(request);
    expect(warnings).toEqual(["read failed: EISDIR"]);
  });

  it.skipIf(process.getuid?.() === 0)("logs EACCES when the file is unreadable", async () => {
    await writeEnv("A=1", 0o000);
    const request = makeRequest();

    const result = await makeHook()({ request }, makeContext().context);

    expect(result).toBe(request);
    expect(warnings).toEqual(["read failed: EACCES"]);
  });
});

describe("permission warning", () => {
  it("warns when the file is readable by group or others, and still injects", async () => {
    await writeEnv("A=1", 0o644);

    const result = await makeHook()({ request: makeRequest() }, makeContext().context);

    expect(warnings).toEqual([`${envPath()} is readable by group or others, run chmod 600`]);
    expect(result.env).toEqual({ A: "1" });
  });

  it("does not warn on 0600", async () => {
    await run("A=1");

    expect(warnings).toEqual([]);
  });

  it("does not warn on Windows", async () => {
    await writeEnv("A=1", 0o644);

    await makeHook({ platform: "win32" })({ request: makeRequest() }, makeContext().context);

    expect(warnings).toEqual([]);
  });
});

describe("protected keys", () => {
  it("skips PATH, HOME, SHELL, USER and PASEO_* and logs them by name", async () => {
    const { result } = await run("PATH=1\nA=1\nHOME=1\nSHELL=1\nUSER=1\nPASEO_X=1");

    expect(result.env).toEqual({ A: "1" });
    expect(lines).toEqual([
      "agent-1 (create) skipped protected PATH, HOME, SHELL, USER, PASEO_X",
      "agent-1 (create) A",
    ]);
  });

  it("does not protect PASEO alone or lowercase names", async () => {
    const { result } = await run("PASEO=1\npath=2\npaseo_x=3");

    expect(result.env).toEqual({ PASEO: "1", path: "2", paseo_x: "3" });
  });

  it("skips config.get when only protected keys remain", async () => {
    const request = makeRequest();
    const { result, get } = await run("PATH=1\nPASEO_AGENT_ID=2", {}, request);

    expect(result).toBe(request);
    expect(get).not.toHaveBeenCalled();
  });

  it("skips config.get when the file has no key", async () => {
    const request = makeRequest();
    const { result, get } = await run("# nothing\n", {}, request);

    expect(result).toBe(request);
    expect(get).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});

describe("precedence", () => {
  it("keeps a key from request.env", async () => {
    const request = makeRequest({ env: { A: "explicit" } });
    const { result } = await run("A=file\nB=file", {}, request);

    expect(result.env).toEqual({ A: "explicit", B: "file" });
    expect(lines).toEqual(["agent-1 (create) B"]);
  });

  it("skips config.get when request.env already has every key", async () => {
    const request = makeRequest({ env: { A: "explicit" } });
    const { result, get } = await run("A=file", {}, request);

    expect(result).toBe(request);
    expect(get).not.toHaveBeenCalled();
  });

  it("does not inject a key from the provider env", async () => {
    const { result } = await run("A=file\nB=file", { claude: { env: { A: "p" } } });

    expect(result.env).toEqual({ B: "file" });
  });

  it("returns the request unchanged and logs nothing when every key is shadowed", async () => {
    const request = makeRequest();
    const { result } = await run("A=file", { claude: { env: { A: "p" } } }, request);

    expect(result).toBe(request);
    expect(lines).toEqual([]);
  });

  it("follows extends through custom providers down to a built-in", async () => {
    const providers = {
      mine: { extends: "base", env: { A: "1" } },
      base: { extends: "codex", env: { B: "1" } },
      codex: { env: { C: "1" } },
    };
    const request = makeRequest({ provider: "mine" });
    const { result } = await run("A=f\nB=f\nC=f\nD=f", providers, request);

    expect(result.env).toEqual({ D: "f" });
  });

  it("ignores extends on a built-in provider", async () => {
    const providers = { claude: { extends: "other", env: {} }, other: { env: { A: "1" } } };
    const { result } = await run("A=f", providers);

    expect(result.env).toEqual({ A: "f" });
  });

  it('stops at extends: "acp"', async () => {
    const providers = { mine: { extends: "acp", env: { A: "1" } }, acp: { env: { B: "1" } } };
    const { result } = await run("A=f\nB=f", providers, makeRequest({ provider: "mine" }));

    expect(result.env).toEqual({ B: "f" });
  });

  it("stops at an unknown base", async () => {
    const providers = { mine: { extends: "ghost", env: { A: "1" } } };
    const { result } = await run("A=f\nB=f", providers, makeRequest({ provider: "mine" }));

    expect(result.env).toEqual({ B: "f" });
  });

  it("terminates on a cycle", async () => {
    const providers = {
      a: { extends: "b", env: { A: "1" } },
      b: { extends: "a", env: { B: "1" } },
    };
    const { result } = await run("A=f\nB=f\nC=f", providers, makeRequest({ provider: "a" }));

    expect(result.env).toEqual({ C: "f" });
  });

  it("injects everything when the provider has no entry", async () => {
    const { result } = await run("A=f", { other: { env: { A: "1" } } });

    expect(result.env).toEqual({ A: "f" });
  });

  it("injects everything when config has no providers", async () => {
    const { result } = await run("A=f", undefined);

    expect(result.env).toEqual({ A: "f" });
  });

  it("tolerates a non-object env, a non-string extends and a non-object entry", async () => {
    const providers = {
      mine: { extends: "base", env: "nope" },
      base: { extends: 42, env: ["A"] },
      other: "nope",
    };
    const { result } = await run("A=f", providers, makeRequest({ provider: "mine" }));

    expect(result.env).toEqual({ A: "f" });
  });

  it("does not follow an entry that is not an object", async () => {
    const { result } = await run("A=f", { mine: null }, makeRequest({ provider: "mine" }));

    expect(result.env).toEqual({ A: "f" });
  });
});

describe("config.get failures", () => {
  it("injects nothing and logs the error name when config.get rejects", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = vi.fn(async () => {
      throw new RangeError("boom");
    });

    const result = await makeHook()(
      { request },
      { paseo: { config: { get } }, signal: new AbortController().signal },
    );

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: RangeError"]);
    expect(lines).toEqual([]);
  });

  it("treats a synchronous throw like a rejection", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = () => {
      throw new Error("boom");
    };

    const result = await makeHook()(
      { request },
      { paseo: { config: { get } }, signal: new AbortController().signal },
    );

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: Error"]);
  });

  it("times out", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = () => new Promise<never>(noop);

    const result = await makeHook({ configTimeoutMs: 10 })(
      { request },
      { paseo: { config: { get } }, signal: new AbortController().signal },
    );

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: TimeoutError"]);
  });

  it("uses a 5 s timeout by default and clears it on success", async () => {
    await writeEnv("A=1");
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await makeHook()({ request: makeRequest() }, makeContext().context);

    const call = setSpy.mock.calls.find(([, ms]) => ms === 5000);
    expect(call).toBeDefined();
    const timer = setSpy.mock.results[setSpy.mock.calls.indexOf(call!)]?.value;
    expect(clearSpy).toHaveBeenCalledWith(timer);
  });

  it("stops when the hook signal aborts", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const controller = new AbortController();
    const get = () => new Promise<never>(noop);

    const pending = makeHook()(
      { request },
      { paseo: { config: { get } }, signal: controller.signal },
    );
    controller.abort();

    expect(await pending).toBe(request);
    expect(warnings).toEqual(["config read failed: AbortError"]);
  });

  it("stops when the hook signal is already aborted", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = vi.fn(() => new Promise<never>(noop));

    const result = await makeHook()(
      { request },
      { paseo: { config: { get } }, signal: AbortSignal.abort() },
    );

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: AbortError"]);
  });
});

describe("unexpected errors", () => {
  it("returns the request unchanged when config is malformed", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = async () => ({ config: null });

    const result = await makeHook()(
      { request },
      { paseo: { config: { get } }, signal: new AbortController().signal },
    );

    expect(result).toBe(request);
    expect(warnings).toEqual(["unexpected error: TypeError"]);
  });

  it("returns the request unchanged when the response itself is malformed", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = async () => null as unknown as { config: unknown };

    const result = await makeHook()(
      { request },
      { paseo: { config: { get } }, signal: new AbortController().signal },
    );

    expect(result).toBe(request);
    expect(warnings).toEqual(["unexpected error: TypeError"]);
  });

  it("returns the request unchanged when a getter throws", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const config = {};
    Object.defineProperty(config, "providers", {
      get() {
        throw new SyntaxError("s3cr3t");
      },
    });
    const get = async () => ({ config });

    const result = await makeHook()(
      { request },
      { paseo: { config: { get } }, signal: new AbortController().signal },
    );

    expect(result).toBe(request);
    expect(warnings).toEqual(["unexpected error: SyntaxError"]);
  });
});

describe("result", () => {
  it("leaves every field but env untouched and keeps file order in the log", async () => {
    const request = makeRequest({
      agentId: "agent-9",
      reason: "refresh",
      purpose: "history",
      provider: "codex",
      env: { KEEP: "1" },
    });
    const { result } = await run("Z=1\nA=2", {}, request);

    expect(result).toEqual({ ...request, env: { KEEP: "1", Z: "1", A: "2" } });
    expect(request.env).toEqual({ KEEP: "1" });
    expect(lines).toEqual(["agent-9 (refresh) Z, A"]);
  });
});

describe("registration", () => {
  it("registers the session_open hook and returns its remover", async () => {
    const remove = vi.fn();
    const before = vi.fn(() => remove);
    const server = { before } as unknown as Parameters<typeof contribute>[0];

    const cleanup = contribute(server);

    expect(before).toHaveBeenCalledWith("agent.session_open", expect.any(Function));
    expect(cleanup).toBe(remove);
  });
});

describe("secrecy", () => {
  it("never leaks a value", async () => {
    const spies = spyOnOutput();
    const sentinels = {
      injected: "s3cr3t-injected",
      protectedPath: "s3cr3t-path",
      protectedPaseo: "s3cr3t-paseo",
      shadowedRequest: "s3cr3t-request",
      shadowedProvider: "s3cr3t-provider",
    };
    const content = [
      `INJECTED=${sentinels.injected}`,
      `PATH=${sentinels.protectedPath}`,
      `PASEO_TOKEN=${sentinels.protectedPaseo}`,
      `REQ=${sentinels.shadowedRequest}`,
      `PROV=${sentinels.shadowedProvider}`,
    ].join("\n");
    // Group-readable so the permission warning fires too.
    await writeEnv(content, 0o644);
    const hook = createSessionOpenHook({ env: { XDG_CONFIG_HOME: xdg } });
    const signal = new AbortController().signal;
    const ok = {
      paseo: {
        config: {
          get: async () => ({ config: { providers: { claude: { env: { PROV: "p" } } } } }),
        },
      },
      signal,
    };
    const rejecting = {
      paseo: {
        config: {
          get: async () => {
            const error = new Error(`config ${sentinels.injected}`);
            error.name = "ConfigError";
            throw error;
          },
        },
      },
      signal,
    };
    const throwing = {
      paseo: {
        config: {
          get: async () => ({
            get config(): unknown {
              throw new Error(`getter ${sentinels.injected}`);
            },
          }),
        },
      },
      signal,
    };
    const request = makeRequest({ env: { REQ: "r" } });

    const results = [
      await hook({ request }, ok),
      await hook({ request }, rejecting),
      await hook({ request }, throwing),
      await hook(
        { request },
        {
          paseo: { config: { get: () => new Promise<never>(noop) } },
          signal: AbortSignal.abort(new Error(sentinels.injected)),
        },
      ),
    ];
    await mkdir(join(xdg, "dir-case", "paseo-plugin-envelope", ".env"), { recursive: true });
    results.push(
      await createSessionOpenHook({ env: { XDG_CONFIG_HOME: join(xdg, "dir-case") } })(
        { request },
        ok,
      ),
    );

    // Wait a tick so deferred output (microtasks, timers) would be caught too.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const output = spies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map(String)
      .join("\n");
    expect(output).toContain("INJECTED");
    expect(output).toContain("config read failed: ConfigError");
    expect(output).toContain("read failed: EISDIR");
    for (const sentinel of Object.values(sentinels)) {
      expect(output).not.toContain(sentinel);
    }
    expect(results[0]?.env).toEqual({ REQ: "r", INJECTED: sentinels.injected });
    for (const result of results.slice(1)) {
      expect(result).toBe(request);
    }
  });
});
