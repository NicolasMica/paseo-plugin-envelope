import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";

import { envelopeSettings } from "../shared/settings";
import { EnvFileSection } from "./env-file-section";
import { run } from "./run";
import type { SettingsSectionProps } from "./section";

/** The sections of the screen, in order. Each one gets the loaded settings. */
const SECTIONS: readonly { id: string; Component: ComponentType<SettingsSectionProps> }[] = [
  { id: "env-file", Component: EnvFileSection },
];

/** Envelope's screen under Settings → Plugins → Envelope. */
export function SettingsScreen(props: PluginSurfaceProps) {
  const settings = useSettings(envelopeSettings);
  if (settings.status === "loading") return <SettingsRow label="Loading settings…" />;
  if (settings.status === "error") {
    return (
      <SettingsSection title="Settings">
        <SettingsCard>
          <SettingsAction
            label="Settings couldn't be loaded"
            error={settings.error}
            actionLabel="Reload"
            onPress={() => run(settings.reload())}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Settings">
        <SettingsCard>
          <SettingsAction
            label="Stored settings are invalid"
            hint="Nothing is injected until they are fixed or reset. Resetting clears the saved path."
            error={settings.saveError ?? settings.error}
            actionLabel="Reset"
            disabled={settings.saving}
            onPress={() => run(settings.reset())}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  return (
    <>
      {SECTIONS.map(({ id, Component }) => (
        <Component key={id} {...props} settings={settings} />
      ))}
    </>
  );
}
