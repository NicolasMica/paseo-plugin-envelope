import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** The plugin's host settings, stored at `<paseoHome>/plugin-settings/<pluginInstallId>/settings.json` as `{"version": 1, "values": {...}}`. */
export const envelopeSettings = defineSettings({
  id: "settings",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Path of the `.env` to read: absolute, or starting with `~/`. Unset or empty injects nothing. */
    envFile: z.string().optional(),
  }),
});
