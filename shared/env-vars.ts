import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { ERROR_CODE } from "./env-file-status";

const file = { path: z.string() };
const code = z.union([z.string().regex(ERROR_CODE), z.literal("UNKNOWN")]);

/** Longest key the reveal RPC accepts. dotenv keys are names, but a malformed file can turn a value fragment into one, so the bound is generous. */
export const MAX_KEY_LENGTH = 1024;

/** What the `.env` key does at the next session open. */
export const envVarStatusSchema = z.discriminatedUnion("kind", [
  /** `PATH`, `HOME`, `SHELL`, `USER` or `PASEO_*`: never injected. */
  z.strictObject({ kind: z.literal("protected") }),
  /** Injected, except into sessions of the providers in `overriddenBy`, whose env in `config.json` (including the providers they `extends`) already sets the key. Empty means every provider. */
  z.strictObject({ kind: z.literal("injected"), overriddenBy: z.array(z.string()) }),
]);

export type EnvVarStatus = z.infer<typeof envVarStatusSchema>;

const variableSchema = z.strictObject({ key: z.string(), status: envVarStatusSchema });

export type EnvVariable = z.infer<typeof variableSchema>;

/**
 * The keys of the `.env` the next session open reads, from the saved settings, in the order dotenv returns them. Every object is strict and none has a field for a value, so the output can't carry one: values only leave the daemon through `env-vars.reveal`.
 */
export const envVarsListSchema = z.discriminatedUnion("state", [
  /** The file was read. `providers` is `unavailable` when the Paseo config couldn't be read, so no key could be checked against the provider env and every unprotected key shows as injected. */
  z.strictObject({
    state: z.literal("ok"),
    ...file,
    variables: z.array(variableSchema),
    providers: z.enum(["ok", "unavailable"]),
  }),
  /** Nothing at the path (`ENOENT`, `ENOTDIR`). */
  z.strictObject({ state: z.literal("missing"), ...file }),
  /** A directory, FIFO, socket or device. */
  z.strictObject({ state: z.literal("not-file"), ...file }),
  /** Any other read failure, including a 5 s timeout. */
  z.strictObject({ state: z.literal("error"), ...file, code }),
  z.strictObject({ state: z.literal("not-configured") }),
  z.strictObject({ state: z.literal("unresolved"), code }),
  z.strictObject({ state: z.literal("relative") }),
  z.strictObject({ state: z.literal("invalid-settings") }),
  z.strictObject({ state: z.literal("settings-unreadable") }),
]);

export type EnvVarsList = z.infer<typeof envVarsListSchema>;

export const envVarsList = defineRpc({
  name: "env-vars.list",
  input: z.object({}),
  output: envVarsListSchema,
});

/** One value, read from the file at call time. It never echoes the requested key, and a failure carries at most an identifier-shaped code. */
export const envVarsRevealSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("ok"), value: z.string() }),
  /** The key is no longer in the file. */
  z.strictObject({ state: z.literal("not-found") }),
  /** The settings or the file can't be used right now. */
  z.strictObject({ state: z.literal("unavailable"), code: code.optional() }),
]);

export type EnvVarsReveal = z.infer<typeof envVarsRevealSchema>;

export const envVarsReveal = defineRpc({
  name: "env-vars.reveal",
  input: z.object({ key: z.string().min(1).max(MAX_KEY_LENGTH) }),
  output: envVarsRevealSchema,
});
