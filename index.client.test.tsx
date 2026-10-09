import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";

import { SettingsScreen } from "./client/settings-screen";
import contribute from "./index.client";

// The real `react-native` can't load under Vitest; the screen only needs `AppState` to exist.
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

describe("client registration", () => {
  it("adds the settings screen and returns its remover", () => {
    const remove = vi.fn<() => void>();
    const addSettingsScreen = vi.fn<PluginClientContext["addSettingsScreen"]>(() => remove);

    const cleanup = contribute({ addSettingsScreen });

    expect(addSettingsScreen).toHaveBeenCalledWith({
      id: "env",
      title: "Environment",
      icon: "FileKey",
      Component: SettingsScreen,
    });
    expect(cleanup).toBe(remove);
  });
});
