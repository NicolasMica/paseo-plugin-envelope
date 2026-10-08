import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createEnvFileStatusHandler } from "./server/env-file-status";
import { createSessionOpenHook } from "./server/inject-env";
import { envFileStatus } from "./shared/env-file-status";
import { envelopeSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(envelopeSettings);
  const readSettings = () => settings.read();
  server.handle(envFileStatus, createEnvFileStatusHandler({ readSettings }));
  return server.before("agent.session_open", createSessionOpenHook({ readSettings }));
}
