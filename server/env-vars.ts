import type { EnvVariable, EnvVarsList, EnvVarsReveal } from "../shared/env-vars";
import { parseEnvFile } from "./env-file";
import { errorCode, isRecord } from "./errors";
import {
  isProtected,
  providerEnvKeys,
  type EnvLoad,
  type EnvSource,
  type InjectEnvContext,
} from "./inject-env";

/** The part of the handler context the handlers use, so tests can pass a fake `paseo`. */
export interface EnvVarsContext {
  paseo: InjectEnvContext["paseo"];
}

type Unusable = Exclude<EnvLoad, { state: "ok" }>;

/** The list state for a `.env` that couldn't be loaded. Errors only travel as identifier-shaped codes. */
function unusable(loaded: Unusable): Exclude<EnvVarsList, { state: "ok" }> {
  if (loaded.state === "unresolved") return { state: "unresolved", code: errorCode(loaded.error) };
  if (loaded.state !== "read-failed") return { state: loaded.state };
  const { path } = loaded;
  const code = errorCode(loaded.error);
  if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", path };
  if (code === "EISDIR" || code === "ENOTREG") return { state: "not-file", path };
  return { state: "error", path, code };
}

/** For each provider id in `config.json`, the keys its env chain sets; null when the config couldn't be read. */
async function providerKeySets(
  source: EnvSource,
  paseo: EnvVarsContext["paseo"],
): Promise<Map<string, Set<string>> | null> {
  const { config, builtins } = await source.readProviders(paseo);
  if (config.status === "rejected" || !isRecord(config.value.config)) return null;
  const providers = config.value.config["providers"];
  // Like the hook: when the snapshot fails, no provider is treated as built-in, which can only report more overrides.
  const builtinIds = builtins.status === "fulfilled" ? builtins.value : new Set<string>();
  const sets = new Map<string, Set<string>>();
  if (!isRecord(providers)) return sets;
  for (const id of Object.keys(providers)) sets.set(id, providerEnvKeys(providers, id, builtinIds));
  return sets;
}

/**
 * Builds the `env-vars.list` handler: the keys of the `.env` the next session open reads, with what happens to each one. It reads through the hooks' source, so it reports exactly what they would inject. It returns names and statuses only, never a value, never rejects and never logs.
 */
export function createEnvVarsListHandler(source: EnvSource) {
  return async (_input: unknown, { paseo }: EnvVarsContext): Promise<EnvVarsList> => {
    const loaded = await source.load();
    if (loaded.state !== "ok") return unusable(loaded);
    const keys = Object.keys(parseEnvFile(loaded.file.content));
    const sets = keys.some((key) => !isProtected(key))
      ? await providerKeySets(source, paseo)
      : new Map<string, Set<string>>();
    const variables = keys.map((key): EnvVariable => {
      if (isProtected(key)) return { key, status: { kind: "protected" } };
      const overriddenBy = [...(sets ?? [])].filter(([, set]) => set.has(key)).map(([id]) => id);
      return { key, status: { kind: "injected", overriddenBy } };
    });
    return {
      state: "ok",
      path: loaded.path,
      variables,
      providers: sets === null ? "unavailable" : "ok",
    };
  };
}

/**
 * Builds the `env-vars.reveal` handler: the value of one key, read from the file at call time, so no value is cached on the daemon. Its output never echoes the key, a failure carries at most an identifier-shaped code, and it never rejects and never logs.
 */
export function createEnvVarsRevealHandler(source: EnvSource) {
  return async ({ key }: { key: string }): Promise<EnvVarsReveal> => {
    const loaded = await source.load();
    if (loaded.state !== "ok") {
      return loaded.state === "unresolved" || loaded.state === "read-failed"
        ? { state: "unavailable", code: errorCode(loaded.error) }
        : { state: "unavailable" };
    }
    const parsed = parseEnvFile(loaded.file.content);
    // `parse` returns a plain object, so `Object.hasOwn` keeps a key like `constructor` from reaching the prototype.
    const value = Object.hasOwn(parsed, key) ? parsed[key] : undefined;
    return value === undefined ? { state: "not-found" } : { state: "ok", value };
  };
}
