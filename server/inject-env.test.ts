import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import contribute from "../index.server";
import { envelopeSettings } from "../shared/settings";
import {
  builtinProviders,
  createSessionOpenHook,
  envFilePath,
  providerEnvKeys,
  resolveEnvFile,
  type EnvelopeSettingsState,
  type InjectEnvContext,
  type InjectEnvOptions,
} from "./inject-env";

// Pass-through by default, so a test can make one `open` fail in a way the real filesystem can't.
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
    log: (line) => {
      lines.push(line);
    },
    warn: (line) => {
      warnings.push(line);
    },
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

// Mirrors Paseo 0.11.1, where these ids are the built-in providers.
const BUILTIN_SNAPSHOT = {
  entries: ["claude", "codex", "copilot", "opencode", "pi", "omp"].map((provider) => ({
    provider,
    source: "builtin",
  })),
};

type Get = InjectEnvContext["paseo"]["config"]["get"];
type Snapshot = InjectEnvContext["paseo"]["providers"]["snapshot"];

function contextWith(
  get: Get,
  signal = new AbortController().signal,
  snapshot: Snapshot = async () => BUILTIN_SNAPSHOT,
): InjectEnvContext {
  return { paseo: { config: { get }, providers: { snapshot } }, signal };
}

function makeContext(providers: unknown = {}, signal = new AbortController().signal) {
  const get = vi.fn<() => Promise<{ requestId: string; config: unknown }>>(async () => ({
    requestId: "r",
    config: { providers },
  }));
  return { context: contextWith(get, signal), get };
}

function ready(envFile?: string): () => Promise<EnvelopeSettingsState> {
  const values = envFile === undefined ? {} : { envFile };
  return async () => ({ status: "ready", revision: "r1", values });
}

/** Makes `close` reject after closing, as a close error after a successful read would. */
function failClose(handle: FileHandle): FileHandle {
  const close = handle.close.bind(handle);
  handle.close = async () => {
    await close();
    throw new Error("close failed");
  };
  return handle;
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
    env["XDG_CONFIG_HOME"] = xdg;
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

describe("non-regular files", () => {
  it.skipIf(process.platform === "win32")("does not hang on a FIFO", async () => {
    await mkdir(join(xdg, "paseo-plugin-envelope"), { recursive: true });
    execFileSync("mkfifo", [envPath()]);
    const request = makeRequest();
    const started = Date.now();

    const result = await makeHook()({ request }, makeContext().context);

    expect(result).toBe(request);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(warnings).toEqual(["read failed: ENOTREG"]);
  });

  it.skipIf(process.platform === "win32")("rejects a symlink to /dev/null", async () => {
    await mkdir(join(xdg, "paseo-plugin-envelope"), { recursive: true });
    await symlink("/dev/null", envPath());
    const request = makeRequest();

    const result = await makeHook()({ request }, makeContext().context);

    expect(result).toBe(request);
    expect(warnings).toEqual(["read failed: ENOTREG"]);
  });

  it.skipIf(process.platform === "win32")("follows a symlink to a regular file", async () => {
    const target = join(xdg, "target.env");
    await writeFile(target, "A=1", { mode: 0o600 });
    await mkdir(join(xdg, "paseo-plugin-envelope"), { recursive: true });
    await symlink(target, envPath());

    const result = await makeHook()({ request: makeRequest() }, makeContext().context);

    expect(result.env).toEqual({ A: "1" });
    expect(warnings).toEqual([]);
  });
});

describe("filesystem failures", () => {
  it("logs UNKNOWN when open rejects with a non-object", async () => {
    vi.mocked(open).mockRejectedValueOnce("boom");
    const request = makeRequest();

    const result = await makeHook()({ request }, makeContext().context);

    expect(result).toBe(request);
    expect(warnings).toEqual(["read failed: UNKNOWN"]);
  });

  it("logs UNKNOWN when the error code is not a string", async () => {
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("boom"), { code: 42 }));
    const request = makeRequest();

    const result = await makeHook()({ request }, makeContext().context);

    expect(result).toBe(request);
    expect(warnings).toEqual(["read failed: UNKNOWN"]);
  });

  it("still injects when closing the file fails", async () => {
    await writeEnv("A=1");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args) =>
      failClose(await actual.open(...args)),
    );

    const result = await makeHook()({ request: makeRequest() }, makeContext().context);

    expect(result.env).toEqual({ A: "1" });
    expect(warnings).toEqual([]);
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

  it("warns once per file state", async () => {
    const hook = makeHook();
    const { context } = makeContext();
    const message = `${envPath()} is readable by group or others, run chmod 600`;
    await writeEnv("A=1", 0o644);

    await hook({ request: makeRequest() }, context);
    await hook({ request: makeRequest() }, context);
    expect(warnings).toEqual([message]);

    await chmod(envPath(), 0o600);
    await hook({ request: makeRequest() }, context);
    expect(warnings).toEqual([message]);

    await chmod(envPath(), 0o644);
    await hook({ request: makeRequest() }, context);
    expect(warnings).toEqual([message, message]);
  });

  it("does not warn on Windows", async () => {
    await writeEnv("A=1", 0o644);

    await makeHook({ platform: "win32" })({ request: makeRequest() }, makeContext().context);

    expect(warnings).toEqual([]);
  });
});

describe("protected keys", () => {
  it("skips PATH, HOME, SHELL, USER and PASEO_* and only counts them", async () => {
    const { result } = await run("PATH=1\nA=1\nHOME=1\nSHELL=1\nUSER=1\nPASEO_X=1");

    expect(result.env).toEqual({ A: "1" });
    expect(lines).toEqual(["agent-1 (create) injected 1, skipped 5 protected"]);
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
    expect(lines).toEqual(["agent-1 (create) injected 0, skipped 2 protected"]);
  });

  it("skips config.get when the file has no key", async () => {
    const request = makeRequest();
    const { result, get } = await run("# nothing\n", {}, request);

    expect(result).toBe(request);
    expect(get).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});

describe("logged counts", () => {
  it("never names a key, whatever its shape", async () => {
    const { result } = await run(
      "API_KEY=1\nhttp_proxy=x\nghp_AbCdEf1234567890=\nAbC123defGHI==\nmy.key=v",
    );

    expect(Object.keys(result.env)).toEqual([
      "API_KEY",
      "http_proxy",
      "ghp_AbCdEf1234567890",
      "AbC123defGHI",
      "my.key",
    ]);
    expect(lines).toEqual(["agent-1 (create) injected 5"]);
  });

  it("counts protected keys and keys already set by the request or the provider chain", async () => {
    const providers = { mine: { extends: "base", env: { P: "1" } }, base: { env: { B: "1" } } };
    const request = makeRequest({ provider: "mine", env: { R: "explicit" } });

    await run("PATH=1\nPASEO_lower=1\nR=f\nP=f\nB=f\nNEW=f", providers, request);

    expect(lines).toEqual(["agent-1 (create) injected 1, skipped 2 protected, 3 already set"]);
  });

  it("logs the summary when every key is already set by the request", async () => {
    const request = makeRequest({ env: { A: "explicit" } });

    await run("A=f\nPATH=f", {}, request);

    expect(lines).toEqual(["agent-1 (create) injected 0, skipped 1 protected, 1 already set"]);
  });
});

describe("settings", () => {
  const custom = () => join(xdg, "custom.env");

  async function runWith(
    readSettings: NonNullable<InjectEnvOptions["readSettings"]>,
    options = {},
  ) {
    const request = makeRequest();
    const { context, get } = makeContext();
    const result = await makeHook({ readSettings, ...options })({ request }, context);
    return { request, result, get };
  }

  it("reads the configured absolute path instead of the default", async () => {
    await writeEnv("DEFAULT=1");
    await writeFile(custom(), "CUSTOM=1", { mode: 0o600 });

    const { result } = await runWith(ready(custom()));

    expect(result.env).toEqual({ CUSTOM: "1" });
  });

  it("expands a leading ~/ with the home directory", async () => {
    await writeFile(custom(), "CUSTOM=1", { mode: 0o600 });

    const { result } = await runWith(ready("~/custom.env"), { homedir: () => xdg });

    expect(result.env).toEqual({ CUSTOM: "1" });
  });

  it("expands ~ alone to the home directory", async () => {
    const { result, request } = await runWith(ready("~"), { homedir: () => xdg });

    expect(result).toBe(request);
    expect(warnings).toEqual(["read failed: EISDIR"]);
  });

  it.each(["custom.env", "./custom.env", "~user/custom.env", "~custom.env"])(
    "rejects the relative path %s without falling back to the default",
    async (envFile) => {
      await writeEnv("DEFAULT=1");

      const { result, request, get } = await runWith(ready(envFile), { homedir: () => xdg });

      expect(result).toBe(request);
      expect(get).not.toHaveBeenCalled();
      expect(warnings).toEqual(["envFile setting is not an absolute path"]);
    },
  );

  it.each([
    ["an empty envFile", ""],
    ["no envFile", undefined],
  ])("uses the default path for %s", async (_label, envFile) => {
    await writeEnv("DEFAULT=1");

    const { result } = await runWith(ready(envFile));

    expect(result.env).toEqual({ DEFAULT: "1" });
  });

  it("warns when the configured file is missing", async () => {
    const { result, request } = await runWith(ready(custom()));

    expect(result).toBe(request);
    expect(warnings).toEqual(["read failed: ENOENT"]);
  });

  it("warns when a parent of the configured file is not a directory", async () => {
    await writeFile(custom(), "", { mode: 0o600 });

    await runWith(ready(join(custom(), ".env")));

    expect(warnings).toEqual(["read failed: ENOTDIR"]);
  });

  it("stays silent when the default file is missing", async () => {
    const { result, request } = await runWith(ready());

    expect(result).toBe(request);
    expect([...lines, ...warnings]).toEqual([]);
  });

  it("names the configured path in the permission warning", async () => {
    await writeFile(custom(), "A=1", { mode: 0o644 });

    await runWith(ready(custom()));

    expect(warnings).toEqual([`${custom()} is readable by group or others, run chmod 600`]);
  });

  it("injects nothing and does not log the error when the settings are invalid", async () => {
    await writeEnv("DEFAULT=1");
    const readSettings = async (): Promise<EnvelopeSettingsState> => ({
      status: "invalid",
      revision: "r1",
      error: "envFile: expected string, received s3cr3t",
    });

    const { result, request, get } = await runWith(readSettings);

    expect(result).toBe(request);
    expect(get).not.toHaveBeenCalled();
    expect(warnings).toEqual(["settings invalid"]);
  });

  it("injects nothing and logs the error name when reading the settings rejects", async () => {
    await writeEnv("DEFAULT=1");

    const { result, request } = await runWith(async () => {
      throw new RangeError("s3cr3t");
    });

    expect(result).toBe(request);
    expect(warnings).toEqual(["settings read failed: RangeError"]);
  });

  it("treats a synchronous throw from the reader like a rejection", async () => {
    await writeEnv("DEFAULT=1");
    const readSettings = (): Promise<EnvelopeSettingsState> => {
      throw new SyntaxError("s3cr3t");
    };

    const { result, request } = await runWith(readSettings);

    expect(result).toBe(request);
    expect(warnings).toEqual(["settings read failed: SyntaxError"]);
  });

  it("returns the request unchanged when the reader resolves a malformed state", async () => {
    await writeEnv("DEFAULT=1");
    const readSettings = async () => malformed<EnvelopeSettingsState>(null);

    const { result, request } = await runWith(readSettings);

    expect(result).toBe(request);
    expect(warnings).toEqual(["unexpected error: TypeError"]);
  });

  it("re-reads the settings on every call", async () => {
    await writeEnv("DEFAULT=1");
    await writeFile(custom(), "CUSTOM=1", { mode: 0o600 });
    const readSettings = vi
      .fn<() => Promise<EnvelopeSettingsState>>()
      .mockImplementationOnce(ready())
      .mockImplementationOnce(ready(custom()));
    const hook = makeHook({ readSettings });
    const { context } = makeContext();

    const first = await hook({ request: makeRequest() }, context);
    const second = await hook({ request: makeRequest() }, context);

    expect(first.env).toEqual({ DEFAULT: "1" });
    expect(second.env).toEqual({ CUSTOM: "1" });
  });

  it("resolves paths without touching the filesystem", () => {
    const home = () => "/home/me";

    expect(resolveEnvFile("/etc/a.env", {}, home)).toEqual({
      path: "/etc/a.env",
      configured: true,
    });
    expect(resolveEnvFile("~/a.env", {}, home)).toEqual({
      path: "/home/me/a.env",
      configured: true,
    });
    expect(resolveEnvFile(undefined, { XDG_CONFIG_HOME: "/xdg" }, home)).toEqual({
      path: "/xdg/paseo-plugin-envelope/.env",
      configured: false,
    });
    expect(resolveEnvFile("a.env", {}, home)).toBeNull();
  });
});

describe("precedence", () => {
  it("keeps a key from request.env", async () => {
    const request = makeRequest({ env: { A: "explicit" } });
    const { result } = await run("A=file\nB=file", {}, request);

    expect(result.env).toEqual({ A: "explicit", B: "file" });
    expect(lines).toEqual(["agent-1 (create) injected 1, 1 already set"]);
  });

  it("skips config.get when request.env already has every key", async () => {
    const request = makeRequest({ env: { A: "explicit" } });
    const { result, get } = await run("A=file", {}, request);

    expect(result).toBe(request);
    expect(get).not.toHaveBeenCalled();
    expect(lines).toEqual(["agent-1 (create) injected 0, 1 already set"]);
  });

  it("does not inject a key from the provider env", async () => {
    const { result } = await run("A=file\nB=file", { claude: { env: { A: "p" } } });

    expect(result.env).toEqual({ B: "file" });
  });

  it("returns the request unchanged and only logs counts when every key is shadowed", async () => {
    const request = makeRequest();
    const { result } = await run("A=file", { claude: { env: { A: "p" } } }, request);

    expect(result).toBe(request);
    expect(lines).toEqual(["agent-1 (create) injected 0, 1 already set"]);
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
    await writeEnv("A=f");
    const get = async () => ({ config: {} });

    const result = await makeHook()(
      { request: makeRequest() },
      contextWith(get, new AbortController().signal),
    );

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
    const get = vi.fn<Get>(async () => {
      throw new RangeError("boom");
    });

    const result = await makeHook()({ request }, contextWith(get, new AbortController().signal));

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

    const result = await makeHook()({ request }, contextWith(get, new AbortController().signal));

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: Error"]);
  });

  it("times out", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = () => new Promise<never>(noop);

    const result = await makeHook({ configTimeoutMs: 10 })(
      { request },
      contextWith(get, new AbortController().signal),
    );

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: TimeoutError"]);
  });

  it("times out after 5 s by default", async () => {
    await writeEnv("A=1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const request = makeRequest();
    let called: () => void = noop;
    const getCalled = new Promise<void>((resolve) => {
      called = resolve;
    });
    const get = () => {
      called();
      return new Promise<never>(noop);
    };
    let settled = false;

    const pending = makeHook()({ request }, contextWith(get, new AbortController().signal)).finally(
      () => {
        settled = true;
      },
    );
    await getCalled;
    await vi.advanceTimersByTimeAsync(4999);

    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(request);
    expect(warnings).toEqual(["config read failed: TimeoutError"]);
  });

  it("clears the timer on success", async () => {
    await writeEnv("A=1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const result = await makeHook()({ request: makeRequest() }, makeContext().context);

    expect(result.env).toEqual({ A: "1" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs UnknownError when config.get rejects with a non-error", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const notAnError: unknown = Object.assign(Object.create(null), { name: "Fake" });
    const get = () => Promise.reject(notAnError);

    const result = await makeHook()({ request }, contextWith(get, new AbortController().signal));

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: UnknownError"]);
  });

  it("stops when the hook signal aborts", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const controller = new AbortController();
    const get = () => new Promise<never>(noop);

    const pending = makeHook()({ request }, contextWith(get, controller.signal));
    controller.abort();

    expect(await pending).toBe(request);
    expect(warnings).toEqual(["config read failed: AbortError"]);
  });

  it("stops when the hook signal is already aborted", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = vi.fn<Get>(() => new Promise<never>(noop));

    const result = await makeHook()({ request }, contextWith(get, AbortSignal.abort()));

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: AbortError"]);
  });
});

describe("unexpected errors", () => {
  it("returns the request unchanged when config is malformed", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = async () => ({ config: null });

    const result = await makeHook()({ request }, contextWith(get, new AbortController().signal));

    expect(result).toBe(request);
    expect(warnings).toEqual(["unexpected error: TypeError"]);
  });

  it("returns the request unchanged when the response itself is malformed", async () => {
    await writeEnv("A=1");
    const request = makeRequest();
    const get = async () => malformed<{ config: unknown }>(null);

    const result = await makeHook()({ request }, contextWith(get, new AbortController().signal));

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

    const result = await makeHook()({ request }, contextWith(get, new AbortController().signal));

    expect(result).toBe(request);
    expect(warnings).toEqual(["unexpected error: SyntaxError"]);
  });
});

describe("result", () => {
  it("leaves every field but env untouched and keeps file order", async () => {
    const request = makeRequest({
      agentId: "agent-9",
      reason: "refresh",
      purpose: "history",
      provider: "codex",
      env: { KEEP: "1" },
    });
    const { result } = await run("Z=1\nA=2", {}, request);

    expect(result).toEqual({ ...request, env: { KEEP: "1", Z: "1", A: "2" } });
    expect(Object.keys(result.env)).toEqual(["KEEP", "Z", "A"]);
    expect(request.env).toEqual({ KEEP: "1" });
    expect(lines).toEqual(["agent-9 (refresh) injected 2"]);
  });
});

describe("registration", () => {
  it("registers the settings document and a hook that reads them", async () => {
    spyOnOutput();
    const custom = join(xdg, "custom.env");
    await writeFile(custom, "A=1", { mode: 0o600 });
    const remove = vi.fn<() => void>();
    const before =
      vi.fn<(event: string, hook: ReturnType<typeof createSessionOpenHook>) => typeof remove>();
    before.mockReturnValue(remove);
    const read = vi.fn<() => Promise<EnvelopeSettingsState>>(ready(custom));
    const registerSettings = vi.fn<() => { read: typeof read; subscribe: () => typeof noop }>(
      () => ({ read, subscribe: () => noop }),
    );
    const server = malformed<Parameters<typeof contribute>[0]>({ before, registerSettings });

    const cleanup = contribute(server);

    expect(registerSettings).toHaveBeenCalledWith(envelopeSettings);
    expect(before).toHaveBeenCalledWith("agent.session_open", expect.any(Function));
    expect(cleanup).toBe(remove);
    const hook = before.mock.calls[0]?.[1];
    assert.isDefined(hook, "no hook registered");
    const result = await hook({ request: makeRequest() }, makeContext().context);
    expect(read).toHaveBeenCalledOnce();
    expect(result.env).toEqual({ A: "1" });
  });

  it("defines a host settings document with an optional envFile", () => {
    expect(envelopeSettings).toMatchObject({ id: "settings", scope: "host", version: 1 });
    expect(envelopeSettings.schema.parse({})).toEqual({});
    expect(envelopeSettings.schema.parse({ envFile: "~/a.env", other: 1 })).toEqual({
      envFile: "~/a.env",
    });
    expect(envelopeSettings.schema.safeParse({ envFile: 1 }).success).toBe(false);
  });
});

describe("provider snapshot", () => {
  const chained = { claude: { extends: "other", env: {} }, other: { env: { A: "1" } } };

  async function runWithSnapshot(snapshot: Snapshot, providers: unknown = chained) {
    await writeEnv("A=f\nB=f");
    const get = async () => ({ config: { providers } });
    return makeHook({ configTimeoutMs: 20 })(
      { request: makeRequest() },
      contextWith(get, undefined, snapshot),
    );
  }

  it("follows extends on an id the snapshot marks custom", async () => {
    const result = await runWithSnapshot(async () => ({
      entries: [{ provider: "claude", source: "custom" }],
    }));

    expect(result.env).toEqual({ B: "f" });
    expect(warnings).toEqual([]);
  });

  it("follows extends on an id absent from the snapshot", async () => {
    const result = await runWithSnapshot(async () => ({ entries: [] }));

    expect(result.env).toEqual({ B: "f" });
  });

  it.each<[string, Snapshot, string]>([
    [
      "rejects",
      async () => {
        throw new RangeError("boom");
      },
      "RangeError",
    ],
    [
      "throws synchronously",
      () => {
        throw new SyntaxError("boom");
      },
      "SyntaxError",
    ],
    ["times out", () => new Promise<never>(noop), "TimeoutError"],
    ["has no entries array", async () => ({ entries: "nope" }), "TypeError"],
    [
      "has an entry without a provider",
      async () => ({ entries: [{ source: "builtin" }] }),
      "TypeError",
    ],
    ["is not an object", async () => malformed<{ entries: unknown }>(null), "TypeError"],
  ])(
    "warns and treats no provider as built-in when the snapshot %s",
    async (_label, snapshot, name) => {
      const result = await runWithSnapshot(snapshot);

      expect(result.env).toEqual({ B: "f" });
      expect(warnings).toEqual([`provider snapshot failed: ${name}`]);
      expect(lines).toEqual(["agent-1 (create) injected 1, 1 already set"]);
    },
  );

  it("only warns about config when both calls fail, leaving no rejection unhandled", async () => {
    await writeEnv("A=f");
    const unhandled = vi.fn<(reason: unknown) => void>();
    process.on("unhandledRejection", unhandled);
    const request = makeRequest();
    const get = async () => {
      throw new RangeError("config");
    };
    const snapshot = async () => {
      throw new SyntaxError("snapshot");
    };

    const result = await makeHook()({ request }, contextWith(get, undefined, snapshot));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    process.off("unhandledRejection", unhandled);

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: RangeError"]);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("calls config.get and the snapshot in parallel", async () => {
    await writeEnv("A=f");
    const order: string[] = [];
    let releaseGet: () => void = noop;
    const get = () =>
      new Promise<{ config: unknown }>((resolve) => {
        order.push("get");
        releaseGet = () => resolve({ config: {} });
      });
    const snapshot = async () => {
      order.push("snapshot");
      releaseGet();
      return BUILTIN_SNAPSHOT;
    };

    const result = await makeHook()(
      { request: makeRequest() },
      contextWith(get, undefined, snapshot),
    );

    expect(order).toEqual(["get", "snapshot"]);
    expect(result.env).toEqual({ A: "f" });
  });

  it("does not call the snapshot when no candidate remains", async () => {
    await writeEnv("PATH=1");
    const get = vi.fn<Get>(async () => ({ config: {} }));
    const snapshot = vi.fn<Snapshot>(async () => BUILTIN_SNAPSHOT);

    await makeHook()({ request: makeRequest() }, contextWith(get, undefined, snapshot));

    expect(snapshot).not.toHaveBeenCalled();
  });

  it("reads built-in ids from the snapshot entries", () => {
    expect(
      builtinProviders({
        entries: [
          { provider: "claude", source: "builtin" },
          { provider: "mine", source: "custom" },
          { provider: "bare" },
        ],
      }),
    ).toEqual(new Set(["claude"]));
    expect(() => builtinProviders({ entries: [null] })).toThrow(TypeError);
    expect(() => builtinProviders({ entries: [{ provider: 1 }] })).toThrow(TypeError);
  });

  it("walks extends unless the current id is built-in", () => {
    const providers = {
      mine: { extends: "codex", env: { A: "1" } },
      codex: { extends: "other", env: { B: "1" } },
      other: { env: { C: "1" } },
    };

    expect(providerEnvKeys(providers, "mine", new Set(["codex"]))).toEqual(new Set(["A", "B"]));
    expect(providerEnvKeys(providers, "mine", new Set())).toEqual(new Set(["A", "B", "C"]));
    expect(providerEnvKeys(null, "mine", new Set())).toEqual(new Set());
  });
});

describe("error output", () => {
  async function failConfig(error: unknown) {
    await writeEnv("A=1");
    const get = async () => {
      throw error;
    };
    await makeHook()({ request: makeRequest() }, contextWith(get));
    return warnings;
  }

  it.each([
    ["a name with spaces", "Leak s3cr3t"],
    ["a name with symbols", "s3cr3t-value"],
    ["a name starting with a digit", "1Error"],
    ["an empty name", ""],
    ["a name longer than 64 characters", `A${"b".repeat(64)}`],
  ])("logs Error for %s", async (_label, name) => {
    const error = new Error("boom");
    error.name = name;

    expect(await failConfig(error)).toEqual(["config read failed: Error"]);
  });

  it("keeps a 64-character identifier name", async () => {
    const error = new Error("boom");
    error.name = `A${"b".repeat(63)}`;

    expect(await failConfig(error)).toEqual([`config read failed: ${error.name}`]);
  });

  it("logs Error when the name is not a string or its getter throws", async () => {
    const nonString = Object.assign(new Error("boom"), { name: 42 });
    const throwing = new Error("boom");
    Object.defineProperty(throwing, "name", {
      get() {
        throw new Error("s3cr3t");
      },
    });

    expect(await failConfig(nonString)).toEqual(["config read failed: Error"]);
    expect(await failConfig(throwing)).toEqual([
      "config read failed: Error",
      "config read failed: Error",
    ]);
  });

  it.each([
    ["a lowercase code", "enoent"],
    ["a code with spaces", "ENOENT s3cr3t"],
    ["a code not starting with E", "XERR"],
    ["a bare E", "E"],
    ["a code longer than 32 characters", `E${"A".repeat(32)}`],
  ])("logs UNKNOWN for %s", async (_label, code) => {
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("boom"), { code }));

    await makeHook()({ request: makeRequest() }, makeContext().context);

    expect(warnings).toEqual(["read failed: UNKNOWN"]);
  });

  it("logs UNKNOWN when the code getter throws", async () => {
    const error = new Error("boom");
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("s3cr3t");
      },
    });
    vi.mocked(open).mockRejectedValueOnce(error);

    await makeHook()({ request: makeRequest() }, makeContext().context);

    expect(warnings).toEqual(["read failed: UNKNOWN"]);
  });
});

describe("secrecy", () => {
  it("never logs a key name or a value", async () => {
    const spies = spyOnOutput();
    const sentinels = {
      injected: "s3cr3t-injected",
      protectedPath: "s3cr3t-path",
      protectedPaseo: "s3cr3t-paseo",
      shadowedRequest: "s3cr3t-request",
      shadowedProvider: "s3cr3t-provider",
    };
    const content = [
      `S3CR3T_INJECTED=${sentinels.injected}`,
      `PATH=${sentinels.protectedPath}`,
      `PASEO_S3CR3T_TOKEN=${sentinels.protectedPaseo}`,
      `S3CR3T_REQ=${sentinels.shadowedRequest}`,
      `S3CR3T_PROV=${sentinels.shadowedProvider}`,
      // A malformed file can turn a value fragment into a key, so no key name is ever logged.
      "ghp_s3cr3tTOKEN=",
      "AKIAS3CR3TFRAGMENT=",
      "PASEO_s3cr3tlower=x",
    ].join("\n");
    const keys = [
      "S3CR3T_INJECTED",
      "PATH",
      "PASEO_S3CR3T_TOKEN",
      "S3CR3T_REQ",
      "S3CR3T_PROV",
      "ghp_s3cr3tTOKEN",
      "AKIAS3CR3TFRAGMENT",
      "PASEO_s3cr3tlower",
    ];
    // Group-readable so the permission warning fires too.
    await writeEnv(content, 0o644);
    const hook = createSessionOpenHook({ env: { XDG_CONFIG_HOME: xdg } });
    const okGet = async () => ({
      config: { providers: { claude: { env: { S3CR3T_PROV: "p" } } } },
    });
    const ok = contextWith(okGet);
    const leakyError = (message: string, name: string) => {
      const error = new Error(`${message} ${sentinels.injected}`);
      error.name = name;
      return error;
    };
    const contexts: InjectEnvContext[] = [
      contextWith(async () => {
        throw leakyError("config", "ConfigError");
      }),
      contextWith(async () => {
        throw leakyError("config", `Leak ${sentinels.injected}`);
      }),
      contextWith(async () => ({
        get config(): unknown {
          throw new Error(`getter ${sentinels.injected}`);
        },
      })),
      contextWith(() => new Promise<never>(noop), AbortSignal.abort(new Error(sentinels.injected))),
      contextWith(okGet, undefined, async () => {
        throw leakyError("snapshot", sentinels.injected);
      }),
      contextWith(okGet, undefined, async () => ({
        entries: [{ provider: sentinels.injected, source: 1 }, 2],
      })),
    ];
    const request = makeRequest({ env: { S3CR3T_REQ: "r" } });

    const results = [await hook({ request }, ok)];
    for (const context of contexts) results.push(await hook({ request }, context));
    await writeEnv("PATH=1\nS3CR3T_REQ=x", 0o600);
    const allSkipped = await hook({ request }, ok);
    await mkdir(join(xdg, "dir-case", "paseo-plugin-envelope", ".env"), { recursive: true });
    results.push(
      await createSessionOpenHook({ env: { XDG_CONFIG_HOME: join(xdg, "dir-case") } })(
        { request },
        ok,
      ),
    );
    const settingsCases: (() => Promise<EnvelopeSettingsState>)[] = [
      async () => ({ status: "invalid", revision: "r", error: `bad ${sentinels.injected}` }),
      async () => {
        throw new Error(`settings ${sentinels.injected}`);
      },
      ready(`relative-${sentinels.injected}`),
      ready(join(xdg, `missing-${sentinels.injected}`)),
    ];
    for (const readSettings of settingsCases) {
      results.push(
        await createSessionOpenHook({ env: { XDG_CONFIG_HOME: xdg }, readSettings })(
          { request },
          ok,
        ),
      );
    }
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error(sentinels.injected), { code: `E ${sentinels.injected}` }),
    );
    results.push(await hook({ request }, ok));

    // Wait a tick so deferred output (microtasks, timers) would be caught too.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const output = spies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map(String)
      .join("\n");
    expect(output).toContain("agent-1 (create) injected 3, skipped 3 protected, 2 already set");
    expect(output).toContain("agent-1 (create) injected 0, skipped 1 protected, 1 already set");
    expect(output).toContain("config read failed: ConfigError");
    expect(output).toContain("config read failed: Error");
    expect(output).toContain("provider snapshot failed: Error");
    expect(output).toContain("provider snapshot failed: TypeError");
    expect(output).toContain("read failed: EISDIR");
    expect(output).toContain("settings invalid");
    expect(output).toContain("settings read failed: Error");
    expect(output).toContain("envFile setting is not an absolute path");
    expect(output).toContain("read failed: ENOENT");
    expect(output).toContain("read failed: UNKNOWN");
    for (const secret of [...Object.values(sentinels), ...keys]) {
      expect(output).not.toContain(secret);
    }
    const injected = {
      S3CR3T_REQ: "r",
      S3CR3T_INJECTED: sentinels.injected,
      ghp_s3cr3tTOKEN: "",
      AKIAS3CR3TFRAGMENT: "",
    };
    expect(results[0]?.env).toEqual(injected);
    expect(results[5]?.env).toEqual(injected);
    expect(results[6]?.env).toEqual(injected);
    expect(allSkipped).toBe(request);
    for (const result of [...results.slice(1, 5), ...results.slice(7)]) {
      expect(result).toBe(request);
    }
  });
});
