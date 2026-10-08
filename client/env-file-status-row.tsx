import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";

import { envFileStatus, type EnvFileStatus } from "../shared/env-file-status";
import { run } from "./run";

interface StatusView {
  label: string;
  hint?: string;
  error?: string;
}

const NOTHING_INJECTED = "Nothing is injected at the next session open.";

function fileHint({ path, source }: { path: string; source: "setting" | "default" }): string {
  return `${path} (${source === "setting" ? "from the setting" : "default path"})`;
}

const SETTINGS_PROBLEMS = {
  relative: "Path not absolute",
  "invalid-settings": "Settings invalid",
  "settings-unreadable": "Settings unreadable",
} as const;

function describe(status: EnvFileStatus): StatusView {
  if (status.state === "ok") return { label: "File found", hint: fileHint(status) };
  if (status.state === "missing") {
    return { label: "File not found", hint: fileHint(status), error: NOTHING_INJECTED };
  }
  if (status.state === "not-file") {
    return {
      label: "Not a regular file",
      hint: fileHint(status),
      error: `${NOTHING_INJECTED} Directories, pipes and sockets are refused.`,
    };
  }
  if (status.state === "error") {
    return {
      label: `File check failed: ${status.code}`,
      hint: fileHint(status),
      error: NOTHING_INJECTED,
    };
  }
  if (status.state === "unresolved") {
    return { label: `Path can't be resolved: ${status.code}`, error: NOTHING_INJECTED };
  }
  return { label: SETTINGS_PROBLEMS[status.state], error: NOTHING_INJECTED };
}

/** The `.env` the next session open reads, checked by the daemon from the saved settings. `revision` keys the check, so it runs again after a save. */
export function EnvFileStatusRow({ revision }: { revision: string }) {
  const getStatus = useRpc(envFileStatus);
  const query = useQuery({
    queryKey: ["env-file-status", revision],
    queryFn: () => getStatus({}),
    // File problems come back as a status, never a rejection, so a retry only covers transport, and one is enough before showing the failure.
    retry: 1,
  });
  let view: StatusView;
  if (query.isPending) {
    view = { label: "Checking the file…" };
  } else if (query.isError) {
    view = { label: "File check failed", error: "The daemon couldn't be asked. Try again." };
  } else {
    view = describe(query.data);
  }
  return (
    <SettingsAction
      label={view.label}
      {...(view.hint === undefined ? {} : { hint: view.hint })}
      error={view.error ?? null}
      actionLabel="Refresh"
      disabled={query.isFetching}
      onPress={() => run(query.refetch())}
    />
  );
}
