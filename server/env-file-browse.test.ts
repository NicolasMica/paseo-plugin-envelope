import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSE_ENTRY_CAP,
  envFileBrowse,
  envFileBrowseSchema,
  type EnvFileBrowse,
} from "../shared/env-file-browse";
import {
  createEnvFileBrowseHandler,
  type DirectoryEntry,
  type EnvFileBrowseOptions,
} from "./env-file-browse";

type Kind = "file" | "directory" | "symlink" | "other";
type Stats = Awaited<ReturnType<NonNullable<EnvFileBrowseOptions["stat"]>>>;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "envelope-browse-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function entry(name: string, kind: Kind): DirectoryEntry {
  return {
    name,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

function stats(kind: "file" | "directory" | "other"): Stats {
  return { isDirectory: () => kind === "directory", isFile: () => kind === "file" };
}

function fail(code: unknown) {
  return async (): Promise<never> => {
    throw Object.assign(new Error("failed"), { code });
  };
}

function noHome(code: unknown) {
  return (): never => {
    throw Object.assign(new Error("SECRET=value"), { code });
  };
}

/** The listing of an `ok` result, failing the test otherwise. */
function listed(result: EnvFileBrowse) {
  assert(result.state === "ok", `listing failed: ${result.state}`);
  return result;
}

/** Runs a handler with `dir` as home and checks its result against the RPC output schema, as the host does. */
async function browse(
  input: { path?: string; containing?: boolean },
  options: EnvFileBrowseOptions = {},
) {
  const result = await createEnvFileBrowseHandler({ homedir: () => dir, ...options })(input);
  expect(envFileBrowseSchema.safeParse(result).success).toBe(true);
  return result;
}

describe("env-file.browse", () => {
  it("is an RPC with an optional path", () => {
    expect(envFileBrowse.name).toBe("env-file.browse");
    expect(envFileBrowse.input.parse({})).toEqual({});
    expect(envFileBrowse.input.parse({ path: "~/a", containing: true })).toEqual({
      path: "~/a",
      containing: true,
    });
  });

  it("lists the home with names and kinds only, dotfiles included", async () => {
    await writeFile(join(dir, ".env"), "SECRET=value");
    await writeFile(join(dir, "notes.txt"), "");
    await mkdir(join(dir, "projects"));
    await symlink(join(dir, "projects"), join(dir, "work"));
    await symlink(join(dir, ".env"), join(dir, "linked.env"));
    await symlink(join(dir, "gone"), join(dir, "broken"));
    execFileSync("mkfifo", [join(dir, "pipe")]);

    for (const input of [{}, { path: "" }, { path: "  " }, { path: "~" }]) {
      const result = await browse(input);

      expect(result).toEqual({
        state: "ok",
        path: dir,
        display: "~",
        parent: dirname(dir),
        separator: "/",
        entries: [
          { name: "projects", kind: "directory" },
          { name: "work", kind: "symlink", target: "directory" },
          { name: ".env", kind: "file" },
          { name: "broken", kind: "symlink", target: "missing" },
          { name: "linked.env", kind: "symlink", target: "file" },
          { name: "notes.txt", kind: "file" },
          { name: "pipe", kind: "other" },
        ],
        total: 7,
      });
      expect(JSON.stringify(result)).not.toContain("value");
    }
  });

  it("sorts directories first, then names case-insensitively and numerically, ties by code point", async () => {
    const readdir = async () => [
      entry("b10", "file"),
      entry("b2", "file"),
      entry("a", "file"),
      entry("A", "file"),
      entry("Zeta", "directory"),
      entry("alpha", "directory"),
      entry("link", "symlink"),
    ];
    const result = await browse({}, { readdir, stat: async () => stats("directory") });

    expect(listed(result).entries.map(({ name }) => name)).toEqual([
      "alpha",
      "link",
      "Zeta",
      "A",
      "a",
      "b2",
      "b10",
    ]);
  });

  it("orders names that differ only by case the same whatever the listing order", async () => {
    for (const names of [
      ["a", "A"],
      ["A", "a"],
    ]) {
      const readdir = async () => names.map((name) => entry(name, "file"));
      expect(listed(await browse({}, { readdir })).entries.map(({ name }) => name)).toEqual([
        "A",
        "a",
      ]);
    }
  });

  it("caps the entries and reports the total", async () => {
    const names = Array.from(
      { length: BROWSE_ENTRY_CAP + 100 },
      (_, index) => `f${String(index).padStart(4, "0")}`,
    );
    const result = await browse(
      {},
      { readdir: async () => names.map((name) => entry(name, "file")) },
    );

    expect(result).toMatchObject({ state: "ok", total: BROWSE_ENTRY_CAP + 100 });
    expect(listed(result).entries).toHaveLength(BROWSE_ENTRY_CAP);
    expect(listed(result).entries.at(-1)?.name).toBe("f0499");
  });

  it("follows at most a cap's worth of symlinks, one at a time, and leaves the rest unknown", async () => {
    const names = Array.from(
      { length: BROWSE_ENTRY_CAP + 1 },
      (_, index) => `l${String(index).padStart(4, "0")}`,
    );
    let running = 0;
    let most = 0;
    const stat = vi.fn<(path: string) => Promise<Stats>>(async () => {
      running += 1;
      most = Math.max(most, running);
      await Promise.resolve();
      running -= 1;
      return stats("other");
    });
    const result = await browse(
      {},
      { readdir: async () => names.toReversed().map((name) => entry(name, "symlink")), stat },
    );

    expect(stat).toHaveBeenCalledTimes(BROWSE_ENTRY_CAP);
    expect(stat).toHaveBeenCalledWith(join(dir, "l0000"));
    expect(most).toBe(1);
    const { entries, total } = listed(result);
    expect(entries[0]).toEqual({ name: "l0000", kind: "symlink", target: "other" });
    expect(total).toBe(BROWSE_ENTRY_CAP + 1);
    // The last link by name was not followed: it is `unknown`, so it sorts with the files, which puts it past the cap.
    expect(stat).not.toHaveBeenCalledWith(join(dir, "l0500"));
    expect(entries.map(({ name }) => name)).not.toContain("l0500");
  });

  it("shows a path under the home with ~, and others as absolute", async () => {
    await mkdir(join(dir, "a", "b"), { recursive: true });

    expect(await browse({ path: "~/a/b" })).toMatchObject({
      path: join(dir, "a", "b"),
      display: "~/a/b",
      parent: "~/a",
    });
    expect(await browse({ path: `${dir}/a/` })).toMatchObject({ display: "~/a", parent: "~" });
    expect(await browse({ path: "/" })).toMatchObject({ path: "/", display: "/", parent: null });
    // A sibling whose name starts with the home's is not under it.
    await mkdir(join(dir, "ab"));
    expect(
      await browse({ path: join(dir, "ab") }, { homedir: () => join(dir, "a") }),
    ).toMatchObject({ display: join(dir, "ab"), parent: dir });
  });

  it("shows paths under a root home with ~", async () => {
    const readdir = async () => [];

    expect(await browse({ path: "/tmp" }, { homedir: () => "/", readdir })).toMatchObject({
      display: "~/tmp",
      parent: "~",
    });
  });

  it("lists the directory containing a path, or the home when it is missing or not a directory", async () => {
    await mkdir(join(dir, "a"));
    await writeFile(join(dir, "a", ".env"), "");

    expect(await browse({ path: "~/a/.env", containing: true })).toMatchObject({
      display: "~/a",
    });
    expect(await browse({ path: "~/gone/.env", containing: true })).toMatchObject({
      display: "~",
    });
    expect(await browse({ path: "~/a/.env/x", containing: true })).toMatchObject({
      display: "~",
    });
    expect(await browse({ path: "", containing: true })).toMatchObject({ display: "~" });
  });

  it("lists ~ and a path ending in a separator themselves, not their parent", async () => {
    await mkdir(join(dir, "proj"));
    const readdir = vi.fn<(path: string) => Promise<DirectoryEntry[]>>(async () => []);

    expect(await browse({ path: "~", containing: true })).toMatchObject({
      path: dir,
      display: "~",
    });
    expect(await browse({ path: "~/proj/", containing: true })).toMatchObject({
      path: join(dir, "proj"),
      display: "~/proj",
    });
    expect(await browse({ path: "/etc/", containing: true }, { readdir })).toMatchObject({
      path: "/etc",
    });
    expect(readdir).toHaveBeenCalledWith("/etc");
  });

  it("falls back to the home for a relative path when listing its folder", async () => {
    expect(await browse({ path: "C:\\Users\\me\\.env", containing: true })).toMatchObject({
      state: "ok",
      path: dir,
      display: "~",
    });
    expect(
      await browse({ path: "agents.env", containing: true }, { homedir: noHome("ENOENT") }),
    ).toEqual({ state: "unresolved", code: "ENOENT" });
  });

  it("doesn't fall back to the home for other failures, or when the home is unknown", async () => {
    const path = join(dir, "gone", ".env");

    expect(await browse({ path, containing: true }, { readdir: fail("EACCES") })).toEqual({
      state: "error",
      path: dirname(path),
      code: "EACCES",
    });
    expect(await browse({ path, containing: true }, { homedir: noHome("ENOENT") })).toEqual({
      state: "missing",
      path: dirname(path),
    });
  });

  it("reports a missing directory and a path that is not a directory", async () => {
    await writeFile(join(dir, "file"), "");

    expect(await browse({ path: "~/gone" })).toEqual({ state: "missing", path: join(dir, "gone") });
    expect(await browse({ path: "~/file" })).toEqual({
      state: "not-directory",
      path: join(dir, "file"),
    });
  });

  it("reports other failures with an identifier-shaped code", async () => {
    expect(await browse({}, { readdir: fail("EACCES") })).toEqual({
      state: "error",
      path: dir,
      code: "EACCES",
    });
    for (const code of ["SECRET=value", "eacces", 42, undefined]) {
      expect(await browse({}, { readdir: fail(code) })).toEqual({
        state: "error",
        path: dir,
        code: "UNKNOWN",
      });
    }
  });

  it("refuses a relative path without listing anything", async () => {
    const readdir = vi.fn<(path: string) => Promise<DirectoryEntry[]>>();

    for (const path of ["a", "./a", "~user/a"]) {
      expect(await browse({ path }, { readdir })).toEqual({ state: "relative" });
    }
    expect(readdir).not.toHaveBeenCalled();
  });

  it("reports a home that can't be resolved when the path needs it, and shows absolute paths without it", async () => {
    expect(await browse({}, { homedir: noHome("ENOENT") })).toEqual({
      state: "unresolved",
      code: "ENOENT",
    });
    expect(await browse({ path: "~/a" }, { homedir: noHome("SECRET=value") })).toEqual({
      state: "unresolved",
      code: "UNKNOWN",
    });
    expect(await browse({ path: dir }, { homedir: noHome("ENOENT") })).toMatchObject({
      state: "ok",
      display: dir,
      parent: dirname(dir),
    });
  });

  it("times out a stalled listing, and concurrent listings share it", async () => {
    vi.useFakeTimers();
    let finish: (entries: DirectoryEntry[]) => void = () => {};
    const readdir = vi.fn<(path: string) => Promise<DirectoryEntry[]>>(
      () =>
        new Promise<DirectoryEntry[]>((resolve) => {
          finish = resolve;
        }),
    );
    const handler = createEnvFileBrowseHandler({ homedir: () => dir, readdir, timeoutMs: 50 });

    const first = handler({});
    const second = handler({ path: "~" });
    await vi.advanceTimersByTimeAsync(50);

    const timedOut = { state: "error", path: dir, code: "ETIMEDOUT" };
    expect(await first).toEqual(timedOut);
    expect(await second).toEqual(timedOut);
    expect(readdir).toHaveBeenCalledOnce();

    // Once the stalled listing settles, the next one starts anew.
    finish([]);
    await vi.advanceTimersByTimeAsync(0);
    const third = handler({});
    await vi.advanceTimersByTimeAsync(0);
    finish([entry("a", "file")]);
    expect(await third).toMatchObject({ state: "ok", entries: [{ name: "a" }], total: 1 });
    expect(readdir).toHaveBeenCalledTimes(2);
  });

  it("leaves a link unknown when its stat stalls, keeps the rest, and a retry waits on the same stat", async () => {
    vi.useFakeTimers();
    const readdir = async () => [
      entry("a", "symlink"),
      entry("b", "symlink"),
      entry("c", "symlink"),
      entry("d.env", "file"),
    ];
    const stat = vi
      .fn<(path: string) => Promise<Stats>>()
      .mockResolvedValueOnce(stats("directory"))
      .mockReturnValueOnce(new Promise<Stats>(() => {}))
      .mockResolvedValueOnce(stats("directory"));
    const handler = createEnvFileBrowseHandler({
      homedir: () => dir,
      readdir,
      stat,
      timeoutMs: 50,
    });

    const first = handler({});
    await vi.advanceTimersByTimeAsync(50);
    const expected = {
      state: "ok",
      entries: [
        { name: "a", kind: "symlink", target: "directory" },
        { name: "b", kind: "symlink", target: "unknown" },
        { name: "c", kind: "symlink", target: "unknown" },
        { name: "d.env", kind: "file" },
      ],
      total: 4,
    };
    expect(await first).toMatchObject(expected);

    const retry = handler({});
    await vi.advanceTimersByTimeAsync(50);
    expect(await retry).toMatchObject(expected);
    expect(stat.mock.calls.map(([path]) => path)).toEqual([
      join(dir, "a"),
      join(dir, "b"),
      join(dir, "a"),
    ]);
  });

  it("refuses a new listing while too many operations are pending, until they settle", async () => {
    vi.useFakeTimers();
    const finishers = new Map<string, (entries: DirectoryEntry[]) => void>();
    const readdir = vi.fn<(path: string) => Promise<DirectoryEntry[]>>(
      (path) =>
        new Promise<DirectoryEntry[]>((resolve) => {
          finishers.set(path, resolve);
        }),
    );
    const handler = createEnvFileBrowseHandler({ homedir: () => dir, readdir, timeoutMs: 50 });

    const stalled = [handler({ path: "/x" }), handler({ path: "/y" })];
    await vi.advanceTimersByTimeAsync(50);
    expect(await Promise.all(stalled)).toEqual([
      { state: "error", path: "/x", code: "ETIMEDOUT" },
      { state: "error", path: "/y", code: "ETIMEDOUT" },
    ]);

    // Timed out but still pending: a new folder is refused without touching the filesystem, a pending one is still shared.
    expect(await handler({ path: "/z" })).toEqual({ state: "error", path: "/z", code: "EBUSY" });
    expect(readdir).toHaveBeenCalledTimes(2);
    const joined = handler({ path: "/x" });
    finishers.get("/x")?.([entry("a", "file")]);
    expect(await joined).toMatchObject({ state: "ok", path: "/x", total: 1 });

    const freed = handler({ path: "/z" });
    await vi.advanceTimersByTimeAsync(0);
    finishers.get("/z")?.([]);
    expect(await freed).toMatchObject({ state: "ok", path: "/z" });
  });

  it("takes the pending limit as an option", async () => {
    vi.useFakeTimers();
    const readdir = vi.fn<(path: string) => Promise<DirectoryEntry[]>>(
      () => new Promise<DirectoryEntry[]>(() => {}),
    );
    const handler = createEnvFileBrowseHandler({ readdir, timeoutMs: 50, maxPending: 1 });

    const stalled = handler({ path: "/x" });
    await vi.advanceTimersByTimeAsync(50);
    await stalled;

    expect(await handler({ path: "/y" })).toEqual({ state: "error", path: "/y", code: "EBUSY" });
  });

  it("defaults to the real filesystem and home", async () => {
    await writeFile(join(dir, "a.env"), "");

    const result = await createEnvFileBrowseHandler()({ path: dir });

    expect(result).toMatchObject({ state: "ok", path: dir, entries: [{ name: "a.env" }] });
  });
});
