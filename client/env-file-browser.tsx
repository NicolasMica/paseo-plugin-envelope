import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import {
  BROWSE_ENTRY_CAP,
  envFileBrowse,
  type BrowseEntry,
  type EnvFileBrowse,
} from "../shared/env-file-browse";
import { childPath } from "./env-file-path";
import { run } from "./run";

interface Location {
  /** Absolute, `~` or `~/…`; empty for the home. */
  path: string;
  /** Lists the directory that contains `path`, or the home when it is gone. */
  containing: boolean;
}

export interface EnvFileBrowserProps {
  open: boolean;
  /** The path to start from: its directory is listed, or the home when it is empty or gone. Read when the browser mounts. */
  start: string;
  onOpenChange: (open: boolean) => void;
  /** Receives the chosen file, in display form (`~/…` under the home). */
  onPick: (path: string) => void;
}

type Listed = Extract<EnvFileBrowse, { state: "ok" }>;
type Problem = Exclude<EnvFileBrowse, Listed>;

const HOME: Location = { path: "", containing: false };

const PROBLEMS = {
  missing: "Folder not found",
  "not-directory": "Not a folder",
  relative: "Path not absolute",
} as const;

function opensAsDirectory(entry: BrowseEntry): boolean {
  return entry.kind === "directory" || entry.target === "directory";
}

function choosable(entry: BrowseEntry): boolean {
  return entry.kind === "file" || entry.target === "file";
}

/** Why an entry can be neither opened nor chosen. */
function refusal(entry: BrowseEntry): string {
  if (entry.target === "unknown") return "Not checked in time. Type the path to use it.";
  if (entry.target === "missing") return "Broken link, can't be chosen.";
  if (entry.kind === "symlink") return "Link to something that isn't a file, can't be chosen.";
  return "Not a regular file, can't be chosen.";
}

function EntryRow({
  entry,
  listing,
  onOpen,
  onChoose,
}: {
  entry: BrowseEntry;
  listing: Listed;
  onOpen: (path: string) => void;
  onChoose: (path: string) => void;
}) {
  const path = childPath(listing.display, listing.separator, entry.name);
  const link = entry.kind === "symlink" ? { hint: "Link" } : {};
  if (opensAsDirectory(entry)) {
    return (
      <SettingsAction
        label={`${entry.name}${listing.separator}`}
        {...link}
        actionLabel="Open"
        onPress={() => onOpen(path)}
      />
    );
  }
  if (choosable(entry)) {
    return (
      <SettingsAction
        label={entry.name}
        {...link}
        actionLabel="Choose"
        onPress={() => onChoose(path)}
      />
    );
  }
  return <SettingsRow label={entry.name} hint={refusal(entry)} />;
}

function ListingRows({
  listing,
  onOpen,
  onChoose,
}: {
  listing: Listed;
  onOpen: (path: string) => void;
  onChoose: (path: string) => void;
}) {
  return (
    <>
      <SettingsRow label={listing.display} hint="Folder on the daemon's machine" />
      <SettingsAction
        label="Parent folder"
        actionLabel="Up"
        disabled={listing.parent === null}
        onPress={() => {
          if (listing.parent !== null) onOpen(listing.parent);
        }}
      />
      {listing.entries.map((entry) => (
        <EntryRow
          key={entry.name}
          entry={entry}
          listing={listing}
          onOpen={onOpen}
          onChoose={onChoose}
        />
      ))}
      {listing.total === 0 ? <SettingsRow label="This folder is empty" /> : null}
      {listing.total > listing.entries.length ? (
        <SettingsRow label={`Showing the first ${BROWSE_ENTRY_CAP} of ${listing.total} entries`} />
      ) : null}
    </>
  );
}

interface ProblemProps {
  result: Problem;
  /** Whether the failing location already is the home, where Go to home would ask again for the same thing. */
  atHome: boolean;
  retrying: boolean;
  onHome: () => void;
  onRetry: () => void;
}

/** Why the folder can't be listed, with a way out: Retry for a failure that can pass (and at home), Go to home elsewhere. */
function ProblemRows({ result, atHome, retrying, onHome, onRetry }: ProblemProps) {
  if (result.state === "unresolved") {
    return (
      <SettingsRow
        label={`Home folder can't be resolved: ${result.code}`}
        error="Type the path in the field instead."
      />
    );
  }
  const label =
    result.state === "error" ? `Couldn't list the folder: ${result.code}` : PROBLEMS[result.state];
  const retry = result.state === "error" || atHome;
  return (
    <>
      <SettingsAction
        label={label}
        {...("path" in result ? { hint: result.path } : {})}
        {...(retry
          ? { actionLabel: "Retry", disabled: retrying, onPress: onRetry }
          : { actionLabel: "Go to home", onPress: onHome })}
      />
      {retry && !atHome ? (
        <SettingsAction
          label="Start from the home folder"
          actionLabel="Go to home"
          onPress={onHome}
        />
      ) : null}
    </>
  );
}

/** A picker over the daemon's filesystem, so the `.env` can be chosen from any client without typing its path. */
export function EnvFileBrowser({ open, start, onOpenChange, onPick }: EnvFileBrowserProps) {
  const [location, setLocation] = useState<Location>({ path: start, containing: true });
  const browse = useRpc(envFileBrowse);
  const query = useQuery({
    queryKey: ["env-file-browse", location.path, location.containing],
    queryFn: () => browse(location.containing ? location : { path: location.path }),
    enabled: open,
    // Listing problems come back as states, never a rejection, so a retry only covers transport.
    retry: 1,
  });
  const openDirectory = (path: string) => setLocation({ path, containing: false });
  const choose = (path: string) => {
    onOpenChange(false);
    onPick(path);
  };

  let body: ReactNode;
  if (query.isPending) {
    body = <SettingsRow label="Loading…" />;
  } else if (query.isError) {
    body = (
      <SettingsAction
        label="Couldn't list the folder"
        error="The daemon couldn't be asked. Try again."
        actionLabel="Retry"
        disabled={query.isFetching}
        onPress={() => run(query.refetch())}
      />
    );
  } else if (query.data.state === "ok") {
    body = <ListingRows listing={query.data} onOpen={openDirectory} onChoose={choose} />;
  } else {
    body = (
      <ProblemRows
        result={query.data}
        atHome={location.path === ""}
        retrying={query.isFetching}
        onHome={() => setLocation(HOME)}
        onRetry={() => run(query.refetch())}
      />
    );
  }

  return (
    <Modal title="Choose the .env file" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <SettingsCard>{body}</SettingsCard>
      </Modal.Content>
    </Modal>
  );
}
