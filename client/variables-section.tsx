import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import {
  envVarsList,
  envVarsReveal,
  type EnvVarStatus,
  type EnvVariable,
  type EnvVarsReveal,
} from "../shared/env-vars";
import { run } from "./run";
import type { SettingsSectionProps } from "./section";

/** Fixed length, so the mask says nothing about the value. */
export const MASK = "••••••••";

const ABOUT =
  "Values stay on the daemon until you press Show, and are hidden again on refresh, when the app goes to the background, or when you close this screen. A key passed when creating an agent (paseo run --env) wins over the .env for that creation only.";
const PROVIDERS_UNAVAILABLE =
  "Provider env couldn't be checked: the Paseo config couldn't be read, so keys a provider sets may show as injected.";

function describe(status: EnvVarStatus): string {
  if (status.kind === "protected") return "Protected: never injected";
  if (status.overriddenBy.length === 0) return "Injected";
  return `Injected, except for ${status.overriddenBy.join(", ")}: set in their provider env`;
}

function revealError(result: Exclude<EnvVarsReveal, { state: "ok" }> | null): string {
  if (result === null) return "The daemon couldn't be asked. Try again.";
  if (result.state === "not-found") return "No longer in the file. Refresh the list.";
  return result.code === undefined
    ? "The file can't be read right now."
    : `The file can't be read right now: ${result.code}`;
}

type Shown = { state: "hidden" } | { state: "loading" } | { state: "shown"; value: string };

function valueLine(shown: Shown): string {
  if (shown.state === "shown") return shown.value;
  return shown.state === "loading" ? "…" : MASK;
}

/** One key, masked until Show fetches its value. The value only lives in this row's state: no query or mutation cache, and it is dropped on Hide and on unmount. */
function VariableRow({ variable: { key, status } }: { variable: EnvVariable }) {
  const reveal = useRpc(envVarsReveal);
  const [shown, setShown] = useState<Shown>({ state: "hidden" });
  const [error, setError] = useState<string | null>(null);
  // Bumped on every press and on unmount, so a reveal that resolves after Hide, a second press or leaving the screen is dropped.
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  async function show(token: number) {
    let result: EnvVarsReveal | null;
    try {
      result = await reveal({ key });
    } catch {
      result = null;
    }
    if (request.current !== token) return;
    if (result?.state === "ok") {
      setShown({ state: "shown", value: result.value });
    } else {
      setShown({ state: "hidden" });
      setError(revealError(result));
    }
  }

  function toggle() {
    request.current += 1;
    setError(null);
    if (shown.state === "hidden") {
      setShown({ state: "loading" });
      run(show(request.current));
    } else {
      setShown({ state: "hidden" });
    }
  }

  return (
    <SettingsAction
      label={key}
      hint={`${describe(status)}\n${valueLine(shown)}`}
      error={error}
      actionLabel={shown.state === "hidden" ? "Show" : "Hide"}
      onPress={toggle}
    />
  );
}

/** The keys of the `.env` in effect, with what each one does at the next session open. Only names and statuses go through the query cache; values are fetched one at a time by their row. */
export function VariablesSection({ settings }: SettingsSectionProps) {
  const list = useRpc(envVarsList);
  // Part of every row key: bumping it remounts the rows, which hides every value at once.
  const [generation, setGeneration] = useState(0);
  // Backgrounding hides every value, which also keeps a shown one out of the app switcher's snapshot.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") setGeneration((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);
  const query = useQuery({
    queryKey: ["env-vars", settings.revision],
    queryFn: () => list({}),
    // File problems come back as a state, never a rejection, so a retry only covers transport.
    retry: 1,
  });

  let header: { label: string; hint?: string; error?: string };
  if (query.isPending) {
    header = { label: "Loading variables…" };
  } else if (query.isError) {
    header = {
      label: "Variables couldn't be listed",
      error: "The daemon couldn't be asked. Try again.",
    };
  } else if (query.data.state === "ok") {
    const count = query.data.variables.length;
    header = {
      label: `${count} ${count === 1 ? "variable" : "variables"}`,
      hint: query.data.providers === "ok" ? ABOUT : `${ABOUT} ${PROVIDERS_UNAVAILABLE}`,
    };
  } else {
    header = { label: "No variables" };
  }
  const variables = query.data?.state === "ok" ? query.data.variables : [];

  return (
    <SettingsSection title="Variables">
      <SettingsCard>
        <SettingsAction
          label={header.label}
          {...(header.hint === undefined ? {} : { hint: header.hint })}
          error={header.error ?? null}
          actionLabel="Refresh"
          disabled={query.isFetching}
          onPress={() => {
            // Hide first, so no value outlives the press, whether the refetch succeeds, fails or is slow.
            setGeneration((value) => value + 1);
            run(query.refetch());
          }}
        />
        {query.isSuccess && variables.length === 0 ? (
          <SettingsRow
            label="Nothing to list"
            hint="Set a readable .env path in Environment file above, or add variables to it."
          />
        ) : null}
        {variables.map((variable) => (
          // Keyed on the generation and the fetch time, so Refresh, backgrounding and every refetch (a background one included) remount the rows and hide every value.
          <VariableRow
            key={`${generation}:${query.dataUpdatedAt}:${variable.key}`}
            variable={variable}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
