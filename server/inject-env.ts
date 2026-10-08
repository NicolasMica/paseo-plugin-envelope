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
import { SECRETS_GUIDELINE, hasSecretsGuideline } from "./guideline";
import { readEnvFile, withTimeout, type EnvFile } from "./read-file";

const PROTECTED_KEYS = new Set(["PATH", "HOME", "SHELL", "USER"]);
// Values must never reach logs, even through a crafted error, so only identifier-shaped names and codes are logged.
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const ERROR_CODE = /^E[A-Z0-9]{1,31}$/u;

export type EnvelopeSettingsState = PluginSettingsState<typeof envelopeSettings.schema>;

export interface InjectEnvOptions {
  /** Reads the plugin settings on every session open. Absent means no settings: the default path applies. */
  readSettings?: () => Promise<EnvelopeSettingsState>;
  configTimeoutMs?: number;
  /** Bounds the whole `.env` read: a file on a stalled mount can block `open`, `stat` or `read` with no limit. */
  readTimeoutMs?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
}

/** The part of the hook context the hook uses, so tests can pass a fake `paseo`. */
export interface InjectEnvContext {
  paseo: {
    config: { get(): Promise<{ config: unknown }> };
    providers: { snapshot(): Promise<{ entries: unknown }> };
  };
  signal: PluginHookContext["signal"];
}

const noop = () => {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `error[key]`, or undefined when a crafted getter or proxy throws. */
function readField(error: object, key: string): unknown {
  try {
    return Reflect.get(error, key);
  } catch {
    return undefined;
  }
}

function errorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const name = readField(error, "name");
  return typeof name === "string" && ERROR_NAME.test(name) ? name : "Error";
}

function errorCode(error: unknown): string {
  const code = isRecord(error) ? readField(error, "code") : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "UNKNOWN";
}

function isProtected(key: string): boolean {
  return PROTECTED_KEYS.has(key) || key.startsWith("PASEO_");
}

/** `<XDG_CONFIG_HOME>/paseo-plugin-envelope/.env`, ignoring an empty or relative `XDG_CONFIG_HOME` as the XDG spec requires. */
export function envFilePath(env: NodeJS.ProcessEnv, home: () => string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(home(), ".config");
  return join(base, "paseo-plugin-envelope", ".env");
}

/** Where to read the `.env`: the `envFile` setting when set, with a leading `~` expanded, else the XDG default. Null when the setting is not an absolute path. */
export function resolveEnvFile(
  envFile: string | undefined,
  env: NodeJS.ProcessEnv,
  home: () => string,
): { path: string; configured: boolean } | null {
  if (envFile === undefined || envFile === "") {
    return { path: envFilePath(env, home), configured: false };
  }
  const path =
    envFile === "~" || envFile.startsWith("~/") ? join(home(), envFile.slice(1)) : envFile;
  return isAbsolute(path) ? { path, configured: true } : null;
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

/** What the `.env` would give a session: the parsed entries and the ones it would inject. */
interface Injection {
  parsedCount: number;
  unprotectedCount: number;
  injected: [string, string][];
}

type AgentCreateRequest = PluginBeforeRequests["agent.create"];

/**
 * Builds the `agent.session_open` before-hook that injects the `.env` chosen by the settings, or the global default, and the `agent.create` before-hook that appends `SECRETS_GUIDELINE` to the system prompt when that injection would add at least one variable. Both share one read path, so a stalled read is shared too. They only ever log key counts, file paths, error codes and error names, never a key name or a value, and they never throw: on any failure they return the request unchanged.
 */
export function createEnvelopeHooks(options: InjectEnvOptions = {}) {
  const {
    readSettings,
    configTimeoutMs = 5000,
    readTimeoutMs = 5000,
    log = (line: string) => console.log(line),
    warn = (line: string) => console.warn(line),
    env = process.env,
    homedir: home = homedir,
    platform = process.platform,
  } = options;
  let warnedFor: string | undefined;
  // A read stuck on a stalled mount holds a libuv thread until it settles, so later session openings share it instead of blocking more threads.
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

  /** The `envFile` setting, or null after a warning when the settings can't be used. */
  async function readEnvFileSetting(
    report: (line: string) => void,
  ): Promise<{ envFile?: string | undefined } | null> {
    if (readSettings === undefined) return {};
    let state: EnvelopeSettingsState;
    try {
      state = await Promise.resolve().then(readSettings);
    } catch (error) {
      report(`settings read failed: ${errorName(error)}`);
      return null;
    }
    // The invalid state's `error` can quote stored values, so it is not logged.
    if (state.status === "invalid") {
      report("settings invalid");
      return null;
    }
    return state.values;
  }

  /** The `.env` content, or null when there is nothing to inject. A quiet call neither warns nor touches the permission-warning state. */
  async function loadEnvFile(quiet: boolean): Promise<string | null> {
    const report = quiet ? noop : warn;
    const setting = await readEnvFileSetting(report);
    if (setting === null) return null;
    const target = resolveEnvFile(setting.envFile, env, home);
    if (target === null) {
      report("envFile setting is not an absolute path");
      return null;
    }
    const { path, configured } = target;
    let file: EnvFile;
    try {
      // No hook signal: Paseo only aborts once it stopped waiting, and the read is bounded anyway.
      file = await withTimeout(readShared(path), readTimeoutMs);
    } catch (error) {
      const code = errorCode(error);
      if (!configured && (code === "ENOENT" || code === "ENOTDIR")) return null;
      report(`read failed: ${code}`);
      return null;
    }

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

    // allSettled observes both rejections, so one failing call never leaves the other unhandled.
    const [configResult, snapshotResult] = await Promise.allSettled([
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
