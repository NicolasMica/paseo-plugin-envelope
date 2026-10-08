import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { envFileStatus, envFileStatusSchema } from "../shared/env-file-status";
import { createEnvFileStatusHandler, type EnvFileStatusOptions } from "./env-file-status";
import { errorCode } from "./errors";
import type { EnvelopeSettingsState } from "./inject-env";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "envelope-status-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function ready(envFile?: string): () => Promise<EnvelopeSettingsState> {
  const values = envFile === undefined ? {} : { envFile };
  return async () => ({ status: "ready", revision: "r1", values });
}

function makeHandler(options: Partial<EnvFileStatusOptions> = {}) {
  return createEnvFileStatusHandler({
    readSettings: ready(),
    env: { XDG_CONFIG_HOME: dir },
    homedir: () => dir,
    ...options,
  });
}

/** Runs the handler and checks its result against the RPC output schema, as the host does. */
async function status(options: Partial<EnvFileStatusOptions> = {}) {
  const result = await makeHandler(options)();
  expect(envFileStatusSchema.safeParse(result).success).toBe(true);
  return result;
}

const defaultPath = () => join(dir, "paseo-plugin-envelope", ".env");

describe("env-file.status", () => {
  it("is an RPC with an empty input", () => {
    expect(envFileStatus.name).toBe("env-file.status");
    expect(envFileStatus.input.parse({})).toEqual({});
  });

  it("reports a regular file at the configured path", async () => {
    const path = join(dir, "agents.env");
    await writeFile(path, "SECRET=value", { mode: 0o600 });

    const result = await status({ readSettings: ready(path) });

    expect(result).toEqual({ state: "ok", path, source: "setting" });
    expect(JSON.stringify(result)).not.toContain("value");
  });

  it("expands a leading ~ with the daemon user's home", async () => {
    await writeFile(join(dir, "agents.env"), "");

    expect(await status({ readSettings: ready("~/agents.env") })).toEqual({
      state: "ok",
      path: join(dir, "agents.env"),
      source: "setting",
    });
  });

  it("follows a symlink to a regular file, like the hook's open", async () => {
    const target = join(dir, "target.env");
    const link = join(dir, "link.env");
    await writeFile(target, "");
    await symlink(target, link);

    expect(await status({ readSettings: ready(link) })).toEqual({
      state: "ok",
      path: link,
      source: "setting",
    });
  });

  it("uses the default path when the setting is empty or absent", async () => {
    await mkdir(join(dir, "paseo-plugin-envelope"));
    await writeFile(defaultPath(), "");

    expect(await status({ readSettings: ready("") })).toEqual({
      state: "ok",
      path: defaultPath(),
      source: "default",
    });
    expect(await status()).toEqual({ state: "ok", path: defaultPath(), source: "default" });
  });

  it("reports a missing file, configured or default", async () => {
    const path = join(dir, "missing.env");

    expect(await status({ readSettings: ready(path) })).toEqual({
      state: "missing",
      path,
      source: "setting",
    });
    expect(await status()).toEqual({ state: "missing", path: defaultPath(), source: "default" });
  });

  it("reports a path under a regular file as missing", async () => {
    const parent = join(dir, "file");
    await writeFile(parent, "");
    const path = join(parent, ".env");

    expect(await status({ readSettings: ready(path) })).toEqual({
      state: "missing",
      path,
      source: "setting",
    });
  });

  it("reports a directory or a FIFO as not a regular file", async () => {
    const fifo = join(dir, "fifo.env");
    execFileSync("mkfifo", [fifo]);

    expect(await status({ readSettings: ready(dir) })).toEqual({
      state: "not-file",
      path: dir,
      source: "setting",
    });
    expect(await status({ readSettings: ready(fifo) })).toEqual({
      state: "not-file",
      path: fifo,
      source: "setting",
    });
  });

  it("reports any other stat failure with its code", async () => {
    const path = join(dir, "agents.env");
    const stat = vi.fn<(path: string) => Promise<{ isFile(): boolean }>>(async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });

    expect(await status({ readSettings: ready(path), stat })).toEqual({
      state: "error",
      path,
      source: "setting",
      code: "EACCES",
    });
    expect(stat).toHaveBeenCalledWith(path);
  });

  it("reports a regular file the daemon can't read, as the hook's open would fail", async () => {
    const path = join(dir, "locked.env");
    await writeFile(path, "SECRET=value");
    await chmod(path, 0o000);
    // Root reads a mode 000 file, so the expectation follows what `access` really says; the injected test below pins EACCES on any user.
    const expected = await access(path, constants.R_OK).then(
      () => ({ state: "ok", path, source: "setting" }),
      (error: unknown) => ({ state: "error", path, source: "setting", code: errorCode(error) }),
    );

    expect(await status({ readSettings: ready(path) })).toEqual(expected);
  });

  it("checks read permission of a regular file only", async () => {
    const path = join(dir, "agents.env");
    await writeFile(path, "");
    const denied = vi.fn<(path: string, mode: number) => Promise<void>>(async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });

    expect(await status({ readSettings: ready(path), access: denied })).toEqual({
      state: "error",
      path,
      source: "setting",
      code: "EACCES",
    });
    expect(denied).toHaveBeenCalledWith(path, constants.R_OK);

    denied.mockClear();
    expect(await status({ readSettings: ready(dir), access: denied })).toMatchObject({
      state: "not-file",
    });
    expect(denied).not.toHaveBeenCalled();
  });

  it("reports a path that can't be resolved, with an identifier-shaped code", async () => {
    const noHome = (code: unknown) => () => {
      throw Object.assign(new Error("SECRET=value"), { code });
    };

    expect(
      await status({ readSettings: ready("~/agents.env"), homedir: noHome("ENOENT") }),
    ).toEqual({ state: "unresolved", code: "ENOENT" });
    expect(
      await status({ readSettings: ready(), env: {}, homedir: noHome("SECRET=value") }),
    ).toEqual({
      state: "unresolved",
      code: "UNKNOWN",
    });
  });

  it("reports a code without an identifier shape as UNKNOWN", async () => {
    const path = join(dir, "agents.env");
    const fail = (code: unknown) => async () => {
      throw Object.assign(new Error("failed"), { code });
    };

    for (const code of ["SECRET=value", "eacces", 42, undefined]) {
      expect(await status({ readSettings: ready(path), stat: fail(code) })).toEqual({
        state: "error",
        path,
        source: "setting",
        code: "UNKNOWN",
      });
    }
  });

  it("times out a stalled stat, and repeated checks share it", async () => {
    vi.useFakeTimers();
    const path = join(dir, "agents.env");
    let finish: (stats: { isFile(): boolean }) => void = () => {};
    const stat = vi.fn<(path: string) => Promise<{ isFile(): boolean }>>(
      () =>
        new Promise<{ isFile(): boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const handler = makeHandler({
      readSettings: ready(path),
      stat,
      access: async () => {},
      timeoutMs: 50,
    });

    const first = handler();
    const second = handler();
    await vi.advanceTimersByTimeAsync(50);

    const timedOut = { state: "error", path, source: "setting", code: "ETIMEDOUT" };
    expect(await first).toEqual(timedOut);
    expect(await second).toEqual(timedOut);
    expect(stat).toHaveBeenCalledOnce();

    // Once the stalled stat settles, the next check starts a new one.
    finish({ isFile: () => true });
    await vi.advanceTimersByTimeAsync(0);
    const third = handler();
    await vi.advanceTimersByTimeAsync(0);
    finish({ isFile: () => true });
    expect(await third).toEqual({ state: "ok", path, source: "setting" });
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it("reports a setting that is not an absolute path, without checking anything", async () => {
    const stat = vi.fn<(path: string) => Promise<{ isFile(): boolean }>>();

    expect(await status({ readSettings: ready("agents.env"), stat })).toEqual({
      state: "relative",
    });
    expect(stat).not.toHaveBeenCalled();
  });

  it("reports invalid settings without their error, which can quote stored values", async () => {
    const readSettings = async (): Promise<EnvelopeSettingsState> => ({
      status: "invalid",
      revision: "r1",
      error: "envFile: expected string, received SECRET=value",
    });

    const result = await status({ readSettings });

    expect(result).toEqual({ state: "invalid-settings" });
  });

  it("reports a settings read that fails or throws synchronously", async () => {
    const rejects = async (): Promise<EnvelopeSettingsState> => {
      throw new Error("SECRET=value");
    };
    const throws = (): Promise<EnvelopeSettingsState> => {
      throw new Error("SECRET=value");
    };

    expect(await status({ readSettings: rejects })).toEqual({ state: "settings-unreadable" });
    expect(await status({ readSettings: throws })).toEqual({ state: "settings-unreadable" });
  });

  it("defaults to the real filesystem, home and environment", async () => {
    const path = join(dir, "agents.env");
    await writeFile(path, "");

    const handler = createEnvFileStatusHandler({ readSettings: ready(path) });

    expect(await handler()).toEqual({ state: "ok", path, source: "setting" });
  });
});
