import { ERROR_CODE } from "../shared/env-file-status";

// Values must never reach logs or the app, even through a crafted error, so only identifier-shaped names and codes are reported.
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `error[key]`, or undefined when a crafted getter or proxy throws. */
function readField(error: object, key: string): unknown {
  try {
    return Reflect.get(error, key);
  } catch {
    return undefined;
  }
}

/** The error's name when it has an identifier shape, else `Error`, or `UnknownError` for a non-Error. */
export function errorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const name = readField(error, "name");
  return typeof name === "string" && ERROR_NAME.test(name) ? name : "Error";
}

/** The error's code when it has the `E…` shape of a Node error code, else `UNKNOWN`. */
export function errorCode(error: unknown): string {
  const code = isRecord(error) ? readField(error, "code") : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "UNKNOWN";
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
