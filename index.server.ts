import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createEnvFileBrowseHandler } from "./server/env-file-browse";
import { createEnvFileStatusHandler } from "./server/env-file-status";
import { createEnvelopeHooks } from "./server/inject-env";
import { envFileBrowse } from "./shared/env-file-browse";
import { envFileStatus } from "./shared/env-file-status";
import { envelopeSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(envelopeSettings);
  const readSettings = () => settings.read();
  server.handle(envFileStatus, createEnvFileStatusHandler({ readSettings }));
  server.handle(envFileBrowse, createEnvFileBrowseHandler());
  const hooks = createEnvelopeHooks({ readSettings });
  const removeCreate = server.before("agent.create", hooks.agentCreate);
  const removeSessionOpen = server.before("agent.session_open", hooks.sessionOpen);
  return () => {
    removeCreate();
    removeSessionOpen();
  };
}
