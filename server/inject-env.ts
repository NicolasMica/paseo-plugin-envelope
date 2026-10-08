import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
  PluginHookContext,
  PluginSessionOpenRequest,
  PluginSettingsState,
} from "@getpaseo/plugin/server";

import type { envelopeSettings } from "../shared/settings";
import { parseEnvFile } from "./env-file";

const PROTECTED_KEYS = new Set(["PATH", "HOME", "SHELL", "USER"]);
// Values must never reach logs, even through a crafted error, so only identifier-shaped names and codes are logged.
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ERROR_CODE = /^E[A-Z0-9]{1,31}$/;

export type EnvelopeSettingsState = PluginSettingsState<typeof envelopeSettings.schema>;

export interface InjectEnvOptions {
  /** Reads the plugin settings on every session open. Absent means no settings: the default path applies. */
  readSettings?: () => Promise<EnvelopeSettingsState>;
  configTimeoutMs?: number;
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
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home(), ".config");
  return join(base, "paseo-plugin-envelope", ".env");
}

/** Where to read the `.env`: the `envFile` setting when set, with a leading `~` expanded, else the XDG default. Null when the setting is not an absolute path. */
export function resolveEnvFile(
  envFile: string | undefined,
  env: NodeJS.ProcessEnv,
  home: () => string,
): { path: string; configured: boolean } | null {
  if (!envFile) return { path: envFilePath(env, home), configured: false };
  const path =
    envFile === "~" || envFile.startsWith("~/") ? join(home(), envFile.slice(1)) : envFile;
  return isAbsolute(path) ? { path, configured: true } : null;
}

interface EnvFile {
  content: string;
  mode: number;
  /** Device, inode and mode, to warn about permissions once per file state. */
  identity: string;
}

/**
 * Reads the file once through one handle. Returns null when it doesn't exist and `missingOk` is set; throws with the original error otherwise, or with `EISDIR` or `ENOTREG` when it isn't a regular file. `O_NONBLOCK` keeps a FIFO with no writer from hanging the open.
 */
async function readEnvFile(path: string, missingOk: boolean): Promise<EnvFile | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (missingOk && (code === "ENOENT" || code === "ENOTDIR")) return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw Object.assign(new Error("not a regular file"), {
        code: stats.isDirectory() ? "EISDIR" : "ENOTREG",
      });
    }
    const content = await handle.readFile("utf8");
    return { content, mode: stats.mode, identity: `${stats.dev}:${stats.ino}:${stats.mode}` };
  } finally {
    await handle.close().catch(() => {});
  }
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
    if (isRecord(entry.env)) {
      for (const key of Object.keys(entry.env)) keys.add(key);
    }
    const base: unknown = entry.extends;
    id = !builtins.has(id) && typeof base === "string" && base !== "acp" ? base : undefined;
  }
  return keys;
}

/** Settles with `promise`, or rejects on timeout or when `signal` aborts, clearing the timer either way. */
function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finish();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    const timer = setTimeout(
      () => settle(() => reject(new DOMException("timed out", "TimeoutError"))),
      ms,
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

/** The provider ids the snapshot marks built-in. Throws a TypeError when the snapshot is malformed. */
export function builtinProviders(snapshot: unknown): Set<string> {
  const entries = isRecord(snapshot) ? snapshot.entries : undefined;
  if (!Array.isArray(entries)) throw new TypeError("snapshot has no entries");
  const builtins = new Set<string>();
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry) || typeof entry.provider !== "string") {
      throw new TypeError("malformed snapshot entry");
    }
    if (entry.source === "builtin") builtins.add(entry.provider);
  }
  return builtins;
}

/**
 * Builds the `agent.session_open` before-hook that injects the `.env` chosen by the settings, or the global default. It only ever logs key counts, file paths, error codes and error names, never a key name or a value, and it never throws: on any failure it returns the request unchanged.
 */
export function createSessionOpenHook(options: InjectEnvOptions = {}) {
  const {
    readSettings,
    configTimeoutMs = 5000,
    log = (line: string) => console.log(line),
    warn = (line: string) => console.warn(line),
    env = process.env,
    homedir: home = homedir,
    platform = process.platform,
  } = options;
  let warnedFor: string | undefined;

  /** The `envFile` setting, or null after a warning when the settings can't be used. */
  async function readEnvFileSetting(): Promise<{ envFile?: string } | null> {
    if (readSettings === undefined) return {};
    let state: EnvelopeSettingsState;
    try {
      state = await Promise.resolve().then(readSettings);
    } catch (error) {
      warn(`settings read failed: ${errorName(error)}`);
      return null;
    }
    // The invalid state's `error` can quote stored values, so it is not logged.
    if (state.status === "invalid") {
      warn("settings invalid");
      return null;
    }
    return state.values;
  }

  /** The `.env` content, or null when there is nothing to inject. */
  async function loadEnvFile(): Promise<string | null> {
    const setting = await readEnvFileSetting();
    if (setting === null) return null;
    const target = resolveEnvFile(setting.envFile, env, home);
    if (target === null) {
      warn("envFile setting is not an absolute path");
      return null;
    }
    const { path, configured } = target;
    let file: EnvFile | null;
    try {
      file = await readEnvFile(path, !configured);
    } catch (error) {
      warn(`read failed: ${errorCode(error)}`);
      return null;
    }
    if (file === null) return null;

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

  async function inject(
    request: PluginSessionOpenRequest,
    { paseo, signal }: InjectEnvContext,
  ): Promise<PluginSessionOpenRequest> {
    const content = await loadEnvFile();
    if (content === null) return request;

    const parsed = Object.entries(parseEnvFile(content));
    if (parsed.length === 0) return request;
    const unprotected = parsed.filter(([key]) => !isProtected(key));
    const candidates = unprotected.filter(([key]) => !Object.hasOwn(request.env, key));
    const summarize = (injected: number) => {
      const protectedCount = parsed.length - unprotected.length;
      const alreadySet = unprotected.length - injected;
      log(
        `${request.agentId} (${request.reason}) injected ${injected}` +
          (protectedCount > 0 ? `, skipped ${protectedCount} protected` : "") +
          (alreadySet > 0 ? `, ${alreadySet} already set` : ""),
      );
    };
    if (candidates.length === 0) {
      summarize(0);
      return request;
    }

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
      warn(`config read failed: ${errorName(configResult.reason)}`);
      return request;
    }
    const { config } = configResult.value;
    if (!isRecord(config)) throw new TypeError("config is not an object");
    let builtins: ReadonlySet<string>;
    if (snapshotResult.status === "fulfilled") {
      builtins = snapshotResult.value;
    } else {
      // Treating no provider as built-in follows every `extends`, which can only skip more keys.
      warn(`provider snapshot failed: ${errorName(snapshotResult.reason)}`);
      builtins = new Set();
    }

    const providerKeys = providerEnvKeys(config.providers, request.provider, builtins);
    const injected = candidates.filter(([key]) => !providerKeys.has(key));
    summarize(injected.length);
    if (injected.length === 0) return request;
    return { ...request, env: { ...request.env, ...Object.fromEntries(injected) } };
  }

  return async (
    { request }: { request: PluginSessionOpenRequest },
    context: InjectEnvContext,
  ): Promise<PluginSessionOpenRequest> => {
    try {
      return await inject(request, context);
    } catch (error) {
      warn(`unexpected error: ${errorName(error)}`);
      return request;
    }
  };
}
