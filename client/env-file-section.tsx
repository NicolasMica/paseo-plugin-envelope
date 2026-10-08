import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useState } from "react";

import { envFilePathError, withEnvFile } from "./env-file-path";
import { EnvFileStatusRow } from "./env-file-status-row";
import { run } from "./run";
import type { EnvelopeValues, SettingsSectionProps } from "./section";

interface Draft {
  text: string;
  /** The values and revision when editing started, so a save over another client's change is a conflict. */
  values: EnvelopeValues;
  revision: string;
  /** The saved path the input was seeded with, so a change saved elsewhere doesn't remount the input mid-edit. */
  seed: string;
}

const HINT =
  "Absolute, or starting with ~/ for the daemon user's home. Leave empty to use the default path. Changes apply to agents at their next session open.";

/** The `envFile` path editor and the status of the file in effect. */
export function EnvFileSection({ settings }: SettingsSectionProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  // Bumped to remount the input with the saved path after a save or a discard.
  const [generation, setGeneration] = useState(0);
  // `saveError` is shared by every section, so it is shown only after this section's own save failed.
  const [saveFailed, setSaveFailed] = useState(false);
  const saved = settings.values.envFile ?? "";
  const { values, revision } = settings;

  const changeText = useCallback(
    (text: string) =>
      setDraft((current) =>
        current === null ? { text, values, revision, seed: saved } : { ...current, text },
      ),
    [values, revision, saved],
  );

  const closeDraft = () => {
    setDraft(null);
    setSaveFailed(false);
    setGeneration((value) => value + 1);
  };

  async function save(current: Draft) {
    setSaveFailed(false);
    if (await settings.save(withEnvFile(current.values, current.text), current.revision)) {
      closeDraft();
    } else {
      setSaveFailed(true);
    }
  }

  function discard() {
    closeDraft();
    run(settings.reload());
  }

  const formatError = draft === null ? null : envFilePathError(draft.text);
  const saveError = draft !== null && saveFailed ? settings.saveError : null;
  const changed = draft !== null && draft.text.trim() !== saved;

  return (
    <SettingsSection title="Environment file">
      <SettingsCard>
        <SettingsInput
          key={`${generation}:${draft === null ? saved : draft.seed}`}
          label="Path"
          hint={HINT}
          initialValue={saved}
          placeholder="Default path"
          onChangeText={changeText}
          disabled={settings.saving}
          error={formatError ?? saveError}
        />
        {draft === null ? null : (
          <SettingsAction
            label={changed ? "Unsaved change" : "No change"}
            actionLabel="Save"
            disabled={settings.saving || !changed || formatError !== null}
            onPress={() => run(save(draft))}
          />
        )}
        {draft === null ? null : (
          <SettingsAction
            label={saveFailed ? "Reload the saved settings" : "Discard your change"}
            {...(saveFailed
              ? { hint: "Discards your change, for example after another client saved first." }
              : {})}
            actionLabel={saveFailed ? "Reload" : "Discard"}
            disabled={settings.saving}
            onPress={discard}
          />
        )}
        <EnvFileStatusRow revision={settings.revision} />
      </SettingsCard>
    </SettingsSection>
  );
}
