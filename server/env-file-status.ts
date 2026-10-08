import { stat as statPath } from "node:fs/promises";
import { homedir } from "node:os";

import type { EnvFileStatus } from "../shared/env-file-status";
import { errorCode, withTimeout } from "./errors";
import { resolveEnvFile, type EnvelopeSettingsState } from "./inject-env";

export interface EnvFileStatusOptions {
  /** The same saved settings the session-open hook reads. */
  readSettings: () => Promise<EnvelopeSettingsState>;
  /** Bounds the `stat`: a file on a stalled mount can block it with no limit. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stat?: (path: string) => Promise<{ isFile(): boolean }>;
}

/**
 * Builds the `env-file.status` handler: the path the next session open reads and what is there. It follows symlinks like the hook's `open`, but never opens the file, and it never throws.
 */
export function createEnvFileStatusHandler(options: EnvFileStatusOptions) {
  const {
    readSettings,
    timeoutMs = 5000,
    env = process.env,
    homedir: home = homedir,
    stat = statPath,
  } = options;
  // A `stat` stuck on a stalled mount holds a libuv thread until it settles, so repeated refreshes share it instead of starving the threadpool the hook reads with.
  const pendingStats = new Map<string, Promise<{ isFile(): boolean }>>();

  function statShared(path: string) {
    let pending = pendingStats.get(path);
    if (pending === undefined) {
      pending = Promise.resolve()
        .then(() => stat(path))
        .finally(() => {
          pendingStats.delete(path);
        });
      pendingStats.set(path, pending);
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

    const target = resolveEnvFile(settings.values.envFile, env, home);
    if (target === null) return { state: "relative" };
    const { path } = target;
    const source = target.configured ? "setting" : "default";

    try {
      const stats = await withTimeout(statShared(path), timeoutMs);
      return { state: stats.isFile() ? "ok" : "not-file", path, source };
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", path, source };
      return { state: "error", path, source, code };
    }
  };
}
