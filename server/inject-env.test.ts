import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import contribute from "../index.server";
import { envelopeSettings } from "../shared/settings";
import {
  createSessionOpenHook,
  envFilePath,
  resolveEnvFile,
  type EnvelopeSettingsState,
  type InjectEnvContext,
  type InjectEnvOptions,
} from "./inject-env";

// Pass-through by default, so a test can make one `open` fail in a way the real filesystem can't.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

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

describe("logged names", () => {
  it("names only uppercase env-style keys and counts the others", async () => {
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
    expect(lines).toEqual(["agent-1 (create) API_KEY, 4 other names"]);
  });

  it("uses the singular for one other name", async () => {
    await run("A=1\nlower=2");

    expect(lines).toEqual(["agent-1 (create) A, 1 other name"]);
  });

  it("applies the same rule to skipped protected keys", async () => {
    await run("PASEO_lower=1");

    expect(lines).toEqual(["agent-1 (create) skipped protected 1 other name"]);
  });
});

describe("settings", () => {
  const custom = () => join(xdg, "custom.env");

  async function runWith(readSettings: InjectEnvOptions["readSettings"], options = {}) {
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
    const readSettings = async () => null as unknown as EnvelopeSettingsState;

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
    await writeEnv("A=f");
    const get = async () => ({ config: {} });

    const result = await makeHook()(
      { request: makeRequest() },
      { paseo: { config: { get } }, signal: new AbortController().signal },
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

    const pending = makeHook()(
      { request },
      { paseo: { config: { get } }, signal: new AbortController().signal },
    ).finally(() => {
      settled = true;
    });
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
    const get = () => Promise.reject(Object.assign(Object.create(null), { name: "Fake" }));

    const result = await makeHook()(
      { request },
      { paseo: { config: { get } }, signal: new AbortController().signal },
    );

    expect(result).toBe(request);
    expect(warnings).toEqual(["config read failed: UnknownError"]);
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
  it("registers the settings document and a hook that reads them", async () => {
    spyOnOutput();
    const custom = join(xdg, "custom.env");
    await writeFile(custom, "A=1", { mode: 0o600 });
    const remove = vi.fn();
    const before = vi.fn(
      (_event: string, _hook: ReturnType<typeof createSessionOpenHook>) => remove,
    );
    const read = vi.fn(ready(custom));
    const registerSettings = vi.fn(() => ({ read, subscribe: () => noop }));
    const server = { before, registerSettings } as unknown as Parameters<typeof contribute>[0];

    const cleanup = contribute(server);

    expect(registerSettings).toHaveBeenCalledWith(envelopeSettings);
    expect(before).toHaveBeenCalledWith("agent.session_open", expect.any(Function));
    expect(cleanup).toBe(remove);
    const hook = before.mock.calls[0]?.[1];
    if (hook === undefined) throw new Error("no hook registered");
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
      // A pasted token parses as a key, so key names count as secrets unless they look like env names.
      "ghp_s3cr3tTOKEN=",
      "PASEO_s3cr3tlower=x",
    ].join("\n");
    const secretKeys = ["ghp_s3cr3tTOKEN", "PASEO_s3cr3tlower"];
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
    expect(output).toContain("settings invalid");
    expect(output).toContain("settings read failed: Error");
    expect(output).toContain("envFile setting is not an absolute path");
    expect(output).toContain("read failed: ENOENT");
    for (const sentinel of [...Object.values(sentinels), ...secretKeys]) {
      expect(output).not.toContain(sentinel);
    }
    expect(results[0]?.env).toEqual({
      REQ: "r",
      INJECTED: sentinels.injected,
      ghp_s3cr3tTOKEN: "",
    });
    for (const result of results.slice(1)) {
      expect(result).toBe(request);
    }
  });
});
