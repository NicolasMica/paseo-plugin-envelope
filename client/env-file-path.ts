import type { EnvelopeValues } from "./section";

// Mirrors the server rule loosely: empty injects nothing, `~` and `~/…` expand to the daemon user's home, and the rest must be absolute on POSIX or Windows. The daemon's status stays the authority.
const ACCEPTED = /^(?:~|~\/.*|\/.*|[A-Za-z]:[\\/].*|\\\\.*)$/su;

/** Why the typed path can't be saved, or null when it looks valid. */
export function envFilePathError(text: string): string | null {
  const path = text.trim();
  return path === "" || ACCEPTED.test(path)
    ? null
    : "Use an absolute path, or one starting with ~/, or leave it empty.";
}

/** The settings to save for the typed path: an empty path removes the setting, so nothing is injected. */
export function withEnvFile(values: EnvelopeValues, text: string): EnvelopeValues {
  const path = text.trim();
  if (path !== "") return { ...values, envFile: path };
  const next = { ...values };
  delete next.envFile;
  return next;
}

/** The path of `name` in a listed directory, in the directory's display form. The home joins with `/`, the only home form the daemon expands. */
export function childPath(directory: string, separator: string, name: string): string {
  if (directory === "~") return `~/${name}`;
  return directory.endsWith(separator) ? `${directory}${name}` : `${directory}${separator}${name}`;
}
