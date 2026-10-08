import { parse } from "dotenv";

/**
 * Reads the content of a `.env` file with dotenv's default parser: no `$VAR` interpolation, no command substitution, and malformed lines are skipped silently. It never throws on content and never logs.
 */
export function parseEnvFile(content: string): Record<string, string> {
  return parse(content);
}
