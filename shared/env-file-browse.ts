import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { ERROR_CODE } from "./env-file-status";

/** At most this many entries are returned for one directory; `total` tells how many there were. */
export const BROWSE_ENTRY_CAP = 500;

const code = z.union([z.string().regex(ERROR_CODE), z.literal("UNKNOWN")]);
const directory = { path: z.string() };

/** One directory entry: its name and kind only, never content, sizes, times or modes. `target` is the kind a symlink points to, following it, and only set for symlinks: `missing` for a broken link, `unknown` when it wasn't followed (past the cap, out of time, or too many pending checks). */
export const browseEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["file", "directory", "symlink", "other"]),
  target: z.enum(["file", "directory", "other", "missing", "unknown"]).optional(),
});

export type BrowseEntry = z.infer<typeof browseEntrySchema>;

/** A listing of one directory of the daemon's filesystem, or why it couldn't be listed. */
export const envFileBrowseSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ok"),
    /** The absolute directory listed. */
    path: z.string(),
    /** The same directory as `~` or `~/…` when it is the home or under it, else absolute. */
    display: z.string(),
    /** The display form of the parent directory, or null at the filesystem root. */
    parent: z.string().nullable(),
    /** The daemon's path separator, to join a name onto `display`. */
    separator: z.string(),
    /** Directories and symlinks to directories first, then by name; at most `BROWSE_ENTRY_CAP`. */
    entries: z.array(browseEntrySchema),
    /** How many entries the directory has, before the cap. */
    total: z.number().int().nonnegative(),
  }),
  /** Nothing at the path (`ENOENT`). */
  z.object({ state: z.literal("missing"), ...directory }),
  /** The path, or one of its parents, is not a directory (`ENOTDIR`). */
  z.object({ state: z.literal("not-directory"), ...directory }),
  /** Any other failure, such as `EACCES`, a 5 s timeout (`ETIMEDOUT`), or too many listings pending on the daemon (`EBUSY`). */
  z.object({ state: z.literal("error"), ...directory, code }),
  /** The requested path is not absolute and doesn't start with `~/`. */
  z.object({ state: z.literal("relative") }),
  /** The daemon user's home couldn't be resolved. */
  z.object({ state: z.literal("unresolved"), code }),
]);

export type EnvFileBrowse = z.infer<typeof envFileBrowseSchema>;

export const envFileBrowse = defineRpc({
  name: "env-file.browse",
  input: z.object({
    /** Absolute, `~` or `~/…`. Absent or blank lists the daemon user's home. */
    path: z.string().optional(),
    /** Lists the directory that contains `path` (`path` itself when it is `~` or ends with a separator), falling back to the home when that is missing, not a directory, or `path` is not absolute. */
    containing: z.boolean().optional(),
  }),
  output: envFileBrowseSchema,
});
