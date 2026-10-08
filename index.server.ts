import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createEnvelopeHooks } from "./server/inject-env";
import { envelopeSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(envelopeSettings);
  const hooks = createEnvelopeHooks({ readSettings: () => settings.read() });
  const removeCreate = server.before("agent.create", hooks.agentCreate);
  const removeSessionOpen = server.before("agent.session_open", hooks.sessionOpen);
  return () => {
    removeCreate();
    removeSessionOpen();
  };
}
