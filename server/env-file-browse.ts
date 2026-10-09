import { readdir as readdirPath, stat as statPath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { RpcInput } from "@getpaseo/plugin";

import {
  BROWSE_ENTRY_CAP,
  type BrowseEntry,
  type EnvFileBrowse,
  type envFileBrowse,
} from "../shared/env-file-browse";
import { errorCode, withTimeout } from "./errors";
import { expandHome } from "./inject-env";

/** The part of a `Dirent` the listing reads. */
export interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface EnvFileBrowseOptions {
  /** Bounds one request: the `readdir`, then the symlink `stat`s with what is left. A stalled mount can block them with no limit. */
  timeoutMs?: number;
  /** How many `readdir`s and `stat`s may be pending at once, across all clients. Each pins a libuv thread until it settles, and the hook's `.env` read shares that pool. */
  maxPending?: number;
  homedir?: () => string;
  /** Lists a directory with its entry types, like `readdir(path, { withFileTypes: true })`. */
  readdir?: (path: string) => Promise<DirectoryEntry[]>;
  /** Follows a symlink to tell what it points to. */
  stat?: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

type Target = NonNullable<BrowseEntry["target"]>;

// A fixed locale, so the order doesn't depend on the daemon's environment.
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "accent" });

/** Case-insensitive and numeric-aware, with ties broken by code point so the order is deterministic. Names in a directory are unique, so a tie is never between equal names. */
function compareNames(a: string, b: string): number {
  const order = collator.compare(a, b);
  if (order !== 0) return order;
  return a < b ? -1 : 1;
}

function opensAsDirectory(entry: BrowseEntry): boolean {
  return entry.kind === "directory" || entry.target === "directory";
}

/** Directories and symlinks to directories first, then by name. */
function compareEntries(a: BrowseEntry, b: BrowseEntry): number {
  const group = Number(opensAsDirectory(b)) - Number(opensAsDirectory(a));
  return group === 0 ? compareNames(a.name, b.name) : group;
}

function kindOf(entry: DirectoryEntry): BrowseEntry["kind"] {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

/** `path` as `~` or `~/…` when it is the home or under it, else as is. */
function toDisplay(path: string, home: string | undefined): string {
  if (home === undefined) return path;
  if (path === home) return "~";
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

/**
 * Builds the `env-file.browse` handler: one directory of the daemon's filesystem, with entry names and kinds only, never content, sizes, times or modes. It never throws and never logs, since paths and names can be sensitive.
 */
export function createEnvFileBrowseHandler(options: EnvFileBrowseOptions = {}) {
  const {
    timeoutMs = 5000,
    maxPending = 2,
    homedir: home = homedir,
    readdir = (path: string) => readdirPath(path, { withFileTypes: true }),
    stat = statPath,
  } = options;
  // Operations stuck on a stalled mount hold a libuv thread until they settle, so repeated requests share them, and new ones are refused past `maxPending`.
  const pendingReads = new Map<string, Promise<DirectoryEntry[]>>();
  const pendingStats = new Map<string, Promise<Target>>();
  let inFlight = 0;

  /** Starts a filesystem operation, counted until it really settles, not until a caller stops waiting. Null when too many are pending. */
  function startShared<T>(
    pending: Map<string, Promise<T>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> | null {
    let shared = pending.get(key);
    if (shared === undefined) {
      if (inFlight >= maxPending) return null;
      inFlight += 1;
      shared = Promise.resolve()
        .then(operation)
        .finally(() => {
          inFlight -= 1;
          pending.delete(key);
        });
      pending.set(key, shared);
    }
    return shared;
  }

  async function targetOf(path: string): Promise<Target> {
    try {
      const stats = await stat(path);
      if (stats.isDirectory()) return "directory";
      return stats.isFile() ? "file" : "other";
    } catch {
      return "missing";
    }
  }

  /** Follows the links one at a time in name order, so a link into a stalled mount holds one thread, until the deadline; links past the cap or the deadline, or refused for too many pending operations, are `unknown`. */
  async function followLinks(dir: string, links: BrowseEntry[], deadline: number) {
    for (const [index, link] of links.entries()) {
      const remaining = deadline - Date.now();
      const pending =
        index < BROWSE_ENTRY_CAP && remaining > 0
          ? startShared(pendingStats, join(dir, link.name), () => targetOf(join(dir, link.name)))
          : null;
      try {
        link.target = pending === null ? "unknown" : await withTimeout(pending, remaining);
      } catch {
        link.target = "unknown";
      }
    }
  }

  async function list(dir: string, homeDir: string | undefined): Promise<EnvFileBrowse> {
    const deadline = Date.now() + timeoutMs;
    const read = startShared(pendingReads, dir, () => readdir(dir));
    if (read === null) return { state: "error", path: dir, code: "EBUSY" };
    let dirents: DirectoryEntry[];
    try {
      dirents = await withTimeout(read, timeoutMs);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { state: "missing", path: dir };
      if (code === "ENOTDIR") return { state: "not-directory", path: dir };
      return { state: "error", path: dir, code };
    }
    const entries = dirents.map((entry): BrowseEntry => ({
      name: entry.name,
      kind: kindOf(entry),
    }));
    // A symlink's target can move it into the directories group, so links are followed before sorting.
    await followLinks(
      dir,
      entries
        .filter((entry) => entry.kind === "symlink")
        .toSorted((a, b) => compareNames(a.name, b.name)),
      deadline,
    );
    entries.sort(compareEntries);
    const parent = dirname(dir);
    return {
      state: "ok",
      path: dir,
      display: toDisplay(dir, homeDir),
      parent: parent === dir ? null : toDisplay(parent, homeDir),
      separator: sep,
      entries: entries.slice(0, BROWSE_ENTRY_CAP),
      total: entries.length,
    };
  }

  function readHome(): string | undefined {
    try {
      return resolve(home());
    } catch {
      return undefined;
    }
  }

  async function listHome(): Promise<EnvFileBrowse> {
    let homeDir: string;
    try {
      homeDir = resolve(home());
    } catch (error) {
      return { state: "unresolved", code: errorCode(error) };
    }
    return list(homeDir, homeDir);
  }

  return async (input: RpcInput<typeof envFileBrowse>): Promise<EnvFileBrowse> => {
    const fallback = input.containing === true;
    const raw = input.path?.trim() ?? "";
    if (raw === "") return listHome();
    let requested: string;
    try {
      // The same `~` expansion as the hook, so a picked path reads the same file.
      requested = expandHome(raw, home);
    } catch (error) {
      return { state: "unresolved", code: errorCode(error) };
    }
    // A draft that isn't a path here (a Windows path on a POSIX daemon) opens the picker at home.
    if (!isAbsolute(requested)) return fallback ? listHome() : { state: "relative" };

    // `~` and a path ending in a separator name a folder, so it is listed itself.
    const folder = raw === "~" || raw.endsWith("/") || raw.endsWith(sep);
    const dir = fallback && !folder ? dirname(resolve(requested)) : resolve(requested);
    const homeDir = readHome();
    const result = await list(dir, homeDir);
    if (
      fallback &&
      homeDir !== undefined &&
      (result.state === "missing" || result.state === "not-directory")
    ) {
      return list(homeDir, homeDir);
    }
    return result;
  };
}
