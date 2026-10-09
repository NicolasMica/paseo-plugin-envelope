import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createEnvFileStatusHandler } from "./server/env-file-status";
import { createEnvVarsListHandler, createEnvVarsRevealHandler } from "./server/env-vars";
import { createEnvSource, createEnvelopeHooks } from "./server/inject-env";
import { envFileStatus } from "./shared/env-file-status";
import { envVarsList, envVarsReveal } from "./shared/env-vars";
import { envelopeSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(envelopeSettings);
  const readSettings = () => settings.read();
  server.handle(envFileStatus, createEnvFileStatusHandler({ readSettings }));
  // One source for the hooks and the variable RPCs, so they share pending reads.
  const source = createEnvSource({ readSettings });
  server.handle(envVarsList, createEnvVarsListHandler(source));
  server.handle(envVarsReveal, createEnvVarsRevealHandler(source));
  const hooks = createEnvelopeHooks({ source });
  const removeCreate = server.before("agent.create", hooks.agentCreate);
  const removeSessionOpen = server.before("agent.session_open", hooks.sessionOpen);
  return () => {
    removeCreate();
    removeSessionOpen();
  };
}
