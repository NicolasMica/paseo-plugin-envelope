import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { PluginHookContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";

import { parseEnvFile } from "./env-file";

// Paseo 0.11.1 ignores `extends` on these ids (BUILTIN_PROVIDER_IDS in provider-registry.js).
const BUILTIN_PROVIDERS = new Set(["claude", "codex", "copilot", "opencode", "pi", "omp"]);
const PROTECTED_KEYS = new Set(["PATH", "HOME", "SHELL", "USER"]);
// A pasted token or base64 line ending in `=` parses as a key, so logs only name keys in the usual uppercase form and count the rest.
const LOGGABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

export interface InjectEnvOptions {
  configTimeoutMs?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
}

/** The part of the hook context the hook uses, so tests can pass a fake `paseo`. */
export interface InjectEnvContext {
  paseo: { config: { get(): Promise<{ config: unknown }> } };
  signal: PluginHookContext["signal"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function errorCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}

function describeNames(keys: string[]): string {
  const shown = keys.filter((key) => LOGGABLE_NAME.test(key));
  const hidden = keys.length - shown.length;
  if (hidden > 0) shown.push(`${hidden} other name${hidden === 1 ? "" : "s"}`);
  return shown.join(", ");
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

interface EnvFile {
  content: string;
  mode: number;
  /** Device, inode and mode, to warn about permissions once per file state. */
  identity: string;
}

/**
 * Reads the file once through one handle. Returns null when it doesn't exist; throws with the original error otherwise, or with `EISDIR` or `ENOTREG` when it isn't a regular file. `O_NONBLOCK` keeps a FIFO with no writer from hanging the open.
 */
async function readEnvFile(path: string): Promise<EnvFile | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
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

/** Collects the env keys of `start` and of the providers it `extends`, the way Paseo merges them. */
export function providerEnvKeys(providers: unknown, start: string): Set<string> {
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
    id =
      !BUILTIN_PROVIDERS.has(id) && typeof base === "string" && base !== "acp" ? base : undefined;
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
      () => settle(() => reject(new DOMException("config read timed out", "TimeoutError"))),
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

/**
 * Builds the `agent.session_open` before-hook that injects the global `.env`. It only ever logs key names, file paths, error codes and error names, never a value, and it never throws: on any failure it returns the request unchanged.
 */
export function createSessionOpenHook(options: InjectEnvOptions = {}) {
  const {
    configTimeoutMs = 5000,
    log = (line: string) => console.log(line),
    warn = (line: string) => console.warn(line),
    env = process.env,
    homedir: home = homedir,
    platform = process.platform,
  } = options;
  let warnedFor: string | undefined;

  async function inject(
    request: PluginSessionOpenRequest,
    { paseo, signal }: InjectEnvContext,
  ): Promise<PluginSessionOpenRequest> {
    const path = envFilePath(env, home);
    let file: EnvFile | null;
    try {
      file = await readEnvFile(path);
    } catch (error) {
      warn(`read failed: ${errorCode(error)}`);
      return request;
    }
    if (file === null) return request;

    if (platform !== "win32" && (file.mode & 0o044) !== 0) {
      if (warnedFor !== file.identity) {
        warn(`${path} is readable by group or others, run chmod 600`);
      }
      warnedFor = file.identity;
    } else {
      warnedFor = undefined;
    }

    const prefix = `${request.agentId} (${request.reason})`;
    const parsed = Object.entries(parseEnvFile(file.content));
    const skipped = parsed.filter(([key]) => isProtected(key)).map(([key]) => key);
    if (skipped.length > 0) log(`${prefix} skipped protected ${describeNames(skipped)}`);

    const candidates = parsed.filter(
      ([key]) => !isProtected(key) && !Object.hasOwn(request.env, key),
    );
    if (candidates.length === 0) return request;

    let response: { config: unknown };
    try {
      response = await withTimeout(
        Promise.resolve().then(() => paseo.config.get()),
        configTimeoutMs,
        signal,
      );
    } catch (error) {
      warn(`config read failed: ${errorName(error)}`);
      return request;
    }
    const { config } = response;
    if (!isRecord(config)) throw new TypeError("config is not an object");

    const providerKeys = providerEnvKeys(config.providers, request.provider);
    const injected = candidates.filter(([key]) => !providerKeys.has(key));
    if (injected.length === 0) return request;

    log(`${prefix} ${describeNames(injected.map(([key]) => key))}`);
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
