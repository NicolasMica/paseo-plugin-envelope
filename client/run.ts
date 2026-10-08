/** Starts a promise from a press handler. The host's settings actions and TanStack's refetch report their failures through their own state, so a rejection has nothing left to tell. */
export function run(promise: Promise<unknown>): void {
  promise.catch(() => {});
}
