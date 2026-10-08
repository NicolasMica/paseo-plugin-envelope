import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createSessionOpenHook } from "./server/inject-env";
import { envelopeSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(envelopeSettings);
  return server.before(
    "agent.session_open",
    createSessionOpenHook({ readSettings: () => settings.read() }),
  );
}
