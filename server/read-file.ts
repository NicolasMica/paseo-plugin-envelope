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

/**
 * Settles with `promise`, or rejects on timeout or when `signal` aborts, clearing the timer either way. It stops waiting rather than cancel: a libuv thread blocked on a stalled mount can't be interrupted. The timeout error has name `TimeoutError` and code `ETIMEDOUT`, so both log shapes can name it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      finish();
    };
    const onAbort = () => {
      const reason: unknown = signal?.reason;
      settle(() => reject(reason));
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            Object.assign(new Error("timed out"), { name: "TimeoutError", code: "ETIMEDOUT" }),
          ),
        ),
      ms,
    );
    // Observe `promise` first, so a rejection after an early abort is never left unhandled.
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
