import type { PluginServerContext } from "@getpaseo/plugin/server";

import { createSessionOpenHook } from "./server/inject-env";

export default function contribute(server: PluginServerContext) {
  return server.before("agent.session_open", createSessionOpenHook());
}
