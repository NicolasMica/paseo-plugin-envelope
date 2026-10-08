import type { PluginClientContext } from "@getpaseo/plugin/client";

import { SettingsScreen } from "./client/settings-screen";

/** Takes only the part of the client context it uses, so tests can pass a minimal fake. */
export default function contribute(client: Pick<PluginClientContext, "addSettingsScreen">) {
  return client.addSettingsScreen({
    id: "env",
    title: "Environment",
    icon: "FileKey",
    Component: SettingsScreen,
  });
}
