import { parse } from "dotenv";

/**
 * Reads the content of a `.env` file with dotenv's default parser: no `$VAR` interpolation, no command substitution,, lines that aren't an assignment are skipped silently, and a broken quote keeps its raw text. It never throws on content and never logs.
 */
export function parseEnvFile(content: string): Record<string, string> {
  return parse(content);
}
