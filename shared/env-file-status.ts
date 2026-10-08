import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** A filesystem error code as Node reports it (`ENOENT`, `EACCES`). Anything else is reported as `UNKNOWN`, so a crafted error can't carry a value. */
export const ERROR_CODE = /^E[A-Z0-9]{1,31}$/u;

const file = { path: z.string() };
const code = z.union([z.string().regex(ERROR_CODE), z.literal("UNKNOWN")]);

/**
 * The state of the `.env` the next session open reads, from the saved settings. It never carries file content, and never the settings' validation error, which can quote stored values.
 */
export const envFileStatusSchema = z.discriminatedUnion("state", [
  /** A regular file the daemon can read, following symlinks. */
  z.object({ state: z.literal("ok"), ...file }),
  /** Nothing at the path. */
  z.object({ state: z.literal("missing"), ...file }),
  /** A directory, FIFO, socket or device: the hook refuses it. */
  z.object({ state: z.literal("not-file"), ...file }),
  /** Any other check failure, including a regular file the daemon can't read (`EACCES`) and a 5 s timeout. */
  z.object({ state: z.literal("error"), ...file, code }),
  /** The `envFile` setting is unset or empty: nothing is injected. */
  z.object({ state: z.literal("not-configured") }),
  /** The path couldn't be resolved, for example when the daemon user has no home directory: nothing is injected. */
  z.object({ state: z.literal("unresolved"), code }),
  /** The setting is not an absolute path: nothing is injected. */
  z.object({ state: z.literal("relative") }),
  /** The stored settings don't match the schema: nothing is injected. */
  z.object({ state: z.literal("invalid-settings") }),
  /** The settings couldn't be read: nothing is injected. */
  z.object({ state: z.literal("settings-unreadable") }),
]);

export type EnvFileStatus = z.infer<typeof envFileStatusSchema>;

export const envFileStatus = defineRpc({
  name: "env-file.status",
  input: z.object({}),
  output: envFileStatusSchema,
});
