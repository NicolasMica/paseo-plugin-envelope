import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useState } from "react";

import { EnvFileBrowser } from "./env-file-browser";
import { envFilePathError, withEnvFile } from "./env-file-path";
import { EnvFileStatusRow } from "./env-file-status-row";
import { run } from "./run";
import type { EnvelopeValues, SettingsSectionProps } from "./section";

interface Draft {
  text: string;
  /** The values and revision when editing started, so a save over another client's change is a conflict. */
  values: EnvelopeValues;
  revision: string;
  /** The saved path when editing started, so a change saved elsewhere doesn't remount the input mid-edit. */
  seed: string;
  /** The text the input was last mounted with: the saved path, or a path picked in the browser. */
  shown: string;
}

const HINT =
  "Absolute, or starting with ~/ for the daemon user's home. Leave empty to inject nothing. Changes apply to agents at their next session open.";

/** The `envFile` path editor and the status of the file in effect. */
export function EnvFileSection({ settings }: SettingsSectionProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  // Bumped to remount the input after a save, a discard or a pick.
  const [generation, setGeneration] = useState(0);
  // `saveError` is shared by every section, so it is shown only after this section's own save failed.
  const [saveFailed, setSaveFailed] = useState(false);
  // Bumped each time the browser opens, so it starts again from the current path.
  const [browsing, setBrowsing] = useState(false);
  const [browseCount, setBrowseCount] = useState(0);
  const saved = settings.values.envFile ?? "";
  const { values, revision } = settings;

  const changeText = useCallback(
    (text: string) =>
      setDraft((current) =>
        current === null
          ? { text, values, revision, seed: saved, shown: saved }
          : { ...current, text },
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

  function openBrowser() {
    setBrowseCount((value) => value + 1);
    setBrowsing(true);
  }

  // Fills the field as a draft by remounting the input with the path; Save still applies it, against the revision captured when the draft started.
  function pick(path: string) {
    setDraft((current) =>
      current === null
        ? { text: path, values, revision, seed: saved, shown: path }
        : { ...current, text: path, shown: path },
    );
    setGeneration((value) => value + 1);
  }

  const current = (draft === null ? saved : draft.text).trim();
  const formatError = draft === null ? null : envFilePathError(draft.text);
  const saveError = draft !== null && saveFailed ? settings.saveError : null;
  const changed = draft !== null && draft.text.trim() !== saved;

  return (
    <>
      <SettingsSection title="Environment file">
        <SettingsCard>
          <SettingsInput
            key={`${generation}:${draft === null ? saved : draft.seed}`}
            label="Path"
            hint={HINT}
            initialValue={draft === null ? saved : draft.shown}
            placeholder="e.g. ~/.env"
            onChangeText={changeText}
            disabled={settings.saving}
            error={formatError ?? saveError}
          />
          <SettingsAction
            label="Pick a file on the daemon's machine"
            actionLabel="Browse"
            disabled={settings.saving}
            onPress={openBrowser}
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
      <EnvFileBrowser
        key={browseCount}
        open={browsing}
        start={envFilePathError(current) === null ? current : ""}
        onOpenChange={setBrowsing}
        onPick={pick}
      />
    </>
  );
}
