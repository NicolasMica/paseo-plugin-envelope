import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
  PluginBeforeRequests,
  PluginHookContext,
  PluginSessionOpenRequest,
  PluginSettingsState,
} from "@getpaseo/plugin/server";

import type { envelopeSettings } from "../shared/settings";
import { parseEnvFile } from "./env-file";
import { errorCode, errorName, isRecord, withTimeout } from "./errors";
import { SECRETS_GUIDELINE, hasSecretsGuideline } from "./guideline";
import { readEnvFile, type EnvFile } from "./read-file";

const PROTECTED_KEYS = new Set(["PATH", "HOME", "SHELL", "USER"]);

export type EnvelopeSettingsState = PluginSettingsState<typeof envelopeSettings.schema>;

export interface EnvSourceOptions {
  /** Reads the plugin settings on every load. */
  readSettings: () => Promise<EnvelopeSettingsState>;
  /** Bounds `paseo.config.get()` and `paseo.providers.snapshot()`, each on its own. */
  configTimeoutMs?: number;
  /** Bounds the whole `.env` read: a file on a stalled mount can block `open`, `stat` or `read` with no limit. */
  readTimeoutMs?: number;
  homedir?: () => string;
}

export interface InjectEnvLogOptions {
  log?: (line: string) => void;
  warn?: (line: string) => void;
  platform?: NodeJS.Platform;
}

/** The hooks either share an `EnvSource` with the RPC handlers, or build their own from the source options; never both, so a source option can't be silently ignored. */
export type InjectEnvOptions = InjectEnvLogOptions &
  (
    | ({ source: EnvSource } & { [Key in keyof EnvSourceOptions]?: never })
    | (EnvSourceOptions & { source?: never })
  );

/** The part of the hook context the hook uses, so tests can pass a fake `paseo`. */
export interface InjectEnvContext {
  paseo: {
    config: { get(): Promise<{ config: unknown }> };
    providers: { snapshot(): Promise<{ entries: unknown }> };
  };
  signal: PluginHookContext["signal"];
}

const noop = () => {};

/** `PATH`, `HOME`, `SHELL`, `USER` and `PASEO_*`, which the `.env` never overrides. */
export function isProtected(key: string): boolean {
  return PROTECTED_KEYS.has(key) || key.startsWith("PASEO_");
}

/** Where to read the `.env`: the `envFile` setting with a leading `~` expanded. Undefined when the setting is unset or empty, null when it is not an absolute path. */
export function resolveEnvFile(
  envFile: string | undefined,
  home: () => string,
): string | null | undefined {
  if (envFile === undefined || envFile === "") return undefined;
  const path =
    envFile === "~" || envFile.startsWith("~/") ? join(home(), envFile.slice(1)) : envFile;
  return isAbsolute(path) ? path : null;
}

/**
 * Collects the env keys of `start` and of the providers it `extends`, the way Paseo merges them. `builtins` holds the ids whose `extends` Paseo ignores (getpaseo/paseo#3178); an id missing from it is followed, which can only skip more keys.
 */
export function providerEnvKeys(
  providers: unknown,
  start: string,
  builtins: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  if (!isRecord(providers)) return keys;
  const visited = new Set<string>();
  let id: string | undefined = start;
  while (id !== undefined && !visited.has(id) && Object.hasOwn(providers, id)) {
    visited.add(id);
    const entry: unknown = providers[id];
    if (!isRecord(entry)) break;
    if (isRecord(entry["env"])) {
      for (const key of Object.keys(entry["env"])) keys.add(key);
    }
    const base = entry["extends"];
    id = !builtins.has(id) && typeof base === "string" && base !== "acp" ? base : undefined;
  }
  return keys;
}

/** The provider ids the snapshot marks built-in. Throws a TypeError when the snapshot is malformed. */
export function builtinProviders(snapshot: unknown): Set<string> {
  const entries = isRecord(snapshot) ? snapshot["entries"] : undefined;
  if (!Array.isArray(entries)) throw new TypeError("snapshot has no entries");
  const builtins = new Set<string>();
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry) || typeof entry["provider"] !== "string") {
      throw new TypeError("malformed snapshot entry");
    }
    if (entry["source"] === "builtin") builtins.add(entry["provider"]);
  }
  return builtins;
}

/** The outcome of loading the `.env` the settings point to. Failures keep their raw error, so each caller decides what it may report. */
export type EnvLoad =
  | { state: "ok"; path: string; file: EnvFile }
  | { state: "settings-unreadable"; error: unknown }
  /** The invalid state's `error` can quote stored values, so it is not kept. */
  | { state: "invalid-settings" }
  /** Resolving the path threw, for example `homedir` without a home directory. */
  | { state: "unresolved"; error: unknown }
  | { state: "not-configured" }
  | { state: "relative" }
  | { state: "read-failed"; path: string; error: unknown };

/** The provider config and the built-in ids, each settled on its own. */
export interface ProvidersRead {
  config: PromiseSettledResult<{ config: unknown }>;
  builtins: PromiseSettledResult<Set<string>>;
}

/** The `.env` read path shared by the hooks and the RPC handlers, so a stalled read is shared too. It never logs. */
export interface EnvSource {
  /** Reads the settings, resolves the path and reads the file under the read timeout. Never rejects. */
  load(): Promise<EnvLoad>;
  /** Reads `paseo.config.get()` and the built-in provider ids in parallel, each under the config timeout and `signal`. Never rejects. */
  readProviders(paseo: InjectEnvContext["paseo"], signal?: AbortSignal): Promise<ProvidersRead>;
}

export function createEnvSource(options: EnvSourceOptions): EnvSource {
  const {
    readSettings,
    configTimeoutMs = 5000,
    readTimeoutMs = 5000,
    homedir: home = homedir,
  } = options;
  // A read stuck on a stalled mount holds a libuv thread until it settles, so later callers share it instead of blocking more threads.
  const pendingReads = new Map<string, Promise<EnvFile>>();

  function readShared(path: string): Promise<EnvFile> {
    let read = pendingReads.get(path);
    if (read === undefined) {
      read = readEnvFile(path).finally(() => {
        pendingReads.delete(path);
      });
      pendingReads.set(path, read);
    }
    return read;
  }

  async function load(): Promise<EnvLoad> {
    let state: EnvelopeSettingsState;
    try {
      state = await Promise.resolve().then(readSettings);
    } catch (error) {
      return { state: "settings-unreadable", error };
    }
    if (state.status === "invalid") return { state: "invalid-settings" };
    let path: ReturnType<typeof resolveEnvFile>;
    try {
      path = resolveEnvFile(state.values.envFile, home);
    } catch (error) {
      return { state: "unresolved", error };
    }
    if (path === undefined) return { state: "not-configured" };
    if (path === null) return { state: "relative" };
    try {
      // No hook signal: Paseo only aborts once it stopped waiting, and the read is bounded anyway.
      return { state: "ok", path, file: await withTimeout(readShared(path), readTimeoutMs) };
    } catch (error) {
      return { state: "read-failed", path, error };
    }
  }

  async function readProviders(
    paseo: InjectEnvContext["paseo"],
    signal?: AbortSignal,
  ): Promise<ProvidersRead> {
    // allSettled observes both rejections, so one failing call never leaves the other unhandled.
    const [config, builtins] = await Promise.allSettled([
      withTimeout(
        Promise.resolve().then(() => paseo.config.get()),
        configTimeoutMs,
        signal,
      ),
      withTimeout(
        Promise.resolve().then(() => paseo.providers.snapshot()),
        configTimeoutMs,
        signal,
      ).then(builtinProviders),
    ]);
    return { config, builtins };
  }

  return { load, readProviders };
}

/** What the `.env` would give a session: the parsed entries and the ones it would inject. */
interface Injection {
  parsedCount: number;
  unprotectedCount: number;
  injected: [string, string][];
}

type AgentCreateRequest = PluginBeforeRequests["agent.create"];

/**
 * Builds the `agent.session_open` before-hook that injects the `.env` the `envFile` setting points to, nothing when it is unset, and the `agent.create` before-hook that appends `SECRETS_GUIDELINE` to the system prompt when that injection would add at least one variable. Both read through one `EnvSource`, shared with the `env-vars` RPC handlers when one is passed, so a stalled read is shared too. They only ever log key counts, file paths, error codes and error names, never a key name or a value, and they never throw: on any failure they return the request unchanged.
 */
export function createEnvelopeHooks(options: InjectEnvOptions) {
  const {
    log = (line: string) => console.log(line),
    warn = (line: string) => console.warn(line),
    platform = process.platform,
  } = options;
  const source = options.source ?? createEnvSource(options);
  let warnedFor: string | undefined;

  /** The `.env` content, or null when there is nothing to inject. A quiet call neither warns nor touches the permission-warning state. */
  async function loadEnvFile(quiet: boolean): Promise<string | null> {
    const report = quiet ? noop : warn;
    const loaded = await source.load();
    switch (loaded.state) {
      case "settings-unreadable":
        report(`settings read failed: ${errorName(loaded.error)}`);
        return null;
      // The invalid state's `error` can quote stored values, so it is not logged.
      case "invalid-settings":
        report("settings invalid");
        return null;
      // Left to the hooks' own error handling, as before the source existed.
      case "unresolved":
        throw loaded.error;
      case "not-configured":
        return null;
      case "relative":
        report("envFile setting is not an absolute path");
        return null;
      case "read-failed":
        report(`read failed: ${errorCode(loaded.error)}`);
        return null;
      case "ok":
        break;
    }
    const { path, file } = loaded;

    if (quiet) return file.content;
    if (platform !== "win32" && (file.mode & 0o044) !== 0) {
      if (warnedFor !== file.identity) {
        warn(`${path} is readable by group or others, run chmod 600`);
      }
      warnedFor = file.identity;
    } else {
      warnedFor = undefined;
    }
    return file.content;
  }

  /** The entries the `.env` would inject into a session of `provider` whose explicit env is `explicit`, or null when there is nothing to report. */
  async function computeInjection(
    provider: string,
    explicit: Readonly<Record<string, string>>,
    { paseo, signal }: InjectEnvContext,
    quiet: boolean,
  ): Promise<Injection | null> {
    const content = await loadEnvFile(quiet);
    if (content === null) return null;

    const parsed = Object.entries(parseEnvFile(content));
    if (parsed.length === 0) return null;
    const unprotected = parsed.filter(([key]) => !isProtected(key));
    const candidates = unprotected.filter(([key]) => !Object.hasOwn(explicit, key));
    const result = (injected: [string, string][]): Injection => ({
      parsedCount: parsed.length,
      unprotectedCount: unprotected.length,
      injected,
    });
    if (candidates.length === 0) return result([]);

    const { config: configResult, builtins: snapshotResult } = await source.readProviders(
      paseo,
      signal,
    );
    if (configResult.status === "rejected") {
      if (!quiet) warn(`config read failed: ${errorName(configResult.reason)}`);
      return null;
    }
    const { config } = configResult.value;
    if (!isRecord(config)) throw new TypeError("config is not an object");
    let builtins: ReadonlySet<string>;
    if (snapshotResult.status === "fulfilled") {
      builtins = snapshotResult.value;
    } else {
      // Treating no provider as built-in follows every `extends`, which can only skip more keys.
      if (!quiet) warn(`provider snapshot failed: ${errorName(snapshotResult.reason)}`);
      builtins = new Set();
    }

    const providerKeys = providerEnvKeys(config["providers"], provider, builtins);
    return result(candidates.filter(([key]) => !providerKeys.has(key)));
  }

  async function inject(
    request: PluginSessionOpenRequest,
    context: InjectEnvContext,
  ): Promise<PluginSessionOpenRequest> {
    const injection = await computeInjection(request.provider, request.env, context, false);
    if (injection === null) return request;
    const { parsedCount, unprotectedCount, injected } = injection;
    const protectedCount = parsedCount - unprotectedCount;
    const alreadySet = unprotectedCount - injected.length;
    log(
      `${request.agentId} (${request.reason}) injected ${injected.length}` +
        (protectedCount > 0 ? `, skipped ${protectedCount} protected` : "") +
        (alreadySet > 0 ? `, ${alreadySet} already set` : ""),
    );
    if (injected.length === 0) return request;
    return { ...request, env: { ...request.env, ...Object.fromEntries(injected) } };
  }

  // Silent: the session_open hook runs right after creation and logs and warns for the same file.
  async function appendGuideline(
    request: AgentCreateRequest,
    context: InjectEnvContext,
  ): Promise<AgentCreateRequest> {
    const existing = request.config.systemPrompt ?? "";
    // A stored agent without a provider handle is re-created with its persisted prompt, guideline included, maybe in older wording.
    if (hasSecretsGuideline(existing)) return request;
    // The create env is ignored: Paseo drops it at the next session opening, where the `.env` value then applies.
    const injection = await computeInjection(request.config.provider, {}, context, true);
    if (injection === null || injection.injected.length === 0) return request;
    const systemPrompt =
      existing.trim() === "" ? SECRETS_GUIDELINE : `${existing}\n\n${SECRETS_GUIDELINE}`;
    return { ...request, config: { ...request.config, systemPrompt } };
  }

  return {
    sessionOpen: async (
      { request }: { request: PluginSessionOpenRequest },
      context: InjectEnvContext,
    ): Promise<PluginSessionOpenRequest> => {
      try {
        return await inject(request, context);
      } catch (error) {
        warn(`unexpected error: ${errorName(error)}`);
        return request;
      }
    },
    agentCreate: async (
      { request }: { request: AgentCreateRequest },
      context: InjectEnvContext,
    ): Promise<AgentCreateRequest> => {
      try {
        return await appendGuideline(request, context);
      } catch {
        return request;
      }
    },
  };
}
