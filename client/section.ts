import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";

import type { envelopeSettings } from "../shared/settings";

export type EnvelopeSettings = SettingsState<typeof envelopeSettings.schema>;
export type ReadySettings = Extract<EnvelopeSettings, { status: "ready" }>;
export type EnvelopeValues = ReadySettings["values"];

/** What each section of the settings screen receives: the surface props, and the settings once they are loaded and valid. `saving` and `saveError` belong to the whole settings document, so they are shared by every section: a section shows `saveError` only after a save of its own failed. */
export interface SettingsSectionProps extends PluginSurfaceProps {
  settings: ReadySettings;
}
