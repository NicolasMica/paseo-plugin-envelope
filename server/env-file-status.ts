import { constants } from "node:fs";
import { access as accessPath, stat as statPath } from "node:fs/promises";
import { homedir } from "node:os";

import type { EnvFileStatus } from "../shared/env-file-status";
import { errorCode, withTimeout } from "./errors";
import { resolveEnvFile, type EnvelopeSettingsState } from "./inject-env";

export interface EnvFileStatusOptions {
  /** The same saved settings the session-open hook reads. */
  readSettings: () => Promise<EnvelopeSettingsState>;
  /** Bounds the `stat` and `access`: a file on a stalled mount can block them with no limit. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stat?: (path: string) => Promise<{ isFile(): boolean }>;
  /** Checks that the daemon can open a regular file for reading, as the hook does. */
  access?: (path: string, mode: number) => Promise<void>;
}

type FileCheck = "ok" | "not-file";

/**
 * Builds the `env-file.status` handler: the path the next session open reads and what is there. It follows symlinks like the hook's `open` and checks read permission, but never opens the file, and it never throws.
 */
export function createEnvFileStatusHandler(options: EnvFileStatusOptions) {
  const {
    readSettings,
    timeoutMs = 5000,
    env = process.env,
    homedir: home = homedir,
    stat = statPath,
    access = accessPath,
  } = options;
  // A check stuck on a stalled mount holds a libuv thread until it settles, so repeated refreshes share it instead of starving the threadpool the hook reads with.
  const pendingChecks = new Map<string, Promise<FileCheck>>();

  /** `stat`, then `access` for a regular file, which rejects with `EACCES` when the hook couldn't open it (mode 000, another owner). */
  async function checkFile(path: string): Promise<FileCheck> {
    if (!(await stat(path)).isFile()) return "not-file";
    await access(path, constants.R_OK);
    return "ok";
  }

  function checkShared(path: string) {
    let pending = pendingChecks.get(path);
    if (pending === undefined) {
      pending = checkFile(path).finally(() => {
        pendingChecks.delete(path);
      });
      pendingChecks.set(path, pending);
    }
    return pending;
  }

  return async (): Promise<EnvFileStatus> => {
    let settings: EnvelopeSettingsState;
    try {
      settings = await Promise.resolve().then(readSettings);
    } catch {
      return { state: "settings-unreadable" };
    }
    // The invalid state's `error` can quote stored values, so it is not returned.
    if (settings.status === "invalid") return { state: "invalid-settings" };

    let target: ReturnType<typeof resolveEnvFile>;
    try {
      // Resolving can call `homedir`, which throws when the daemon user has no home.
      target = resolveEnvFile(settings.values.envFile, env, home);
    } catch (error) {
      return { state: "unresolved", code: errorCode(error) };
    }
    if (target === null) return { state: "relative" };
    const { path } = target;
    const source = target.configured ? "setting" : "default";

    try {
      return { state: await withTimeout(checkShared(path), timeoutMs), path, source };
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", path, source };
      return { state: "error", path, source, code };
    }
  };
}
