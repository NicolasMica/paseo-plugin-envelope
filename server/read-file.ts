import { constants } from "node:fs";
import { open } from "node:fs/promises";

export interface EnvFile {
  content: string;
  mode: number;
  /** Device, inode and mode, to warn about permissions once per file state. */
  identity: string;
}

/**
 * Reads the file once through one handle. Throws with the original error, or with `EISDIR` or `ENOTREG` when it isn't a regular file. `O_NONBLOCK` keeps a FIFO with no writer from hanging the open.
 */
export async function readEnvFile(path: string): Promise<EnvFile> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw Object.assign(new Error("not a regular file"), {
        code: stats.isDirectory() ? "EISDIR" : "ENOTREG",
      });
    }
    const content = await handle.readFile("utf8");
    return { content, mode: stats.mode, identity: `${stats.dev}:${stats.ino}:${stats.mode}` };
  } finally {
    await handle.close().catch(() => {});
  }
}
