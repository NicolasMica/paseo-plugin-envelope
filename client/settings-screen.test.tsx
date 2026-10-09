import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root, type TestInstance } from "test-renderer";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import { envFileStatus, type EnvFileStatus } from "../shared/env-file-status";
import { envelopeSettings } from "../shared/settings";
import { envFilePathError } from "./env-file-path";
import type { EnvelopeSettings, EnvelopeValues, ReadySettings } from "./section";
import { SettingsScreen } from "./settings-screen";

interface Parser {
  parse(value: unknown): unknown;
}

/** The host-provided state this test drives: the settings document and the status RPC. */
const host = vi.hoisted(() => {
  const state: {
    settings: unknown;
    listeners: Set<() => void>;
    rpc: (input: unknown) => Promise<unknown>;
    rpcContract: unknown;
    settingsDefinition: unknown;
  } = {
    settings: undefined,
    listeners: new Set(),
    rpc: async () => {
      throw new Error("no RPC stub");
    },
    rpcContract: undefined,
    settingsDefinition: undefined,
  };
  return state;
});

// The SDK's client modules ship no runtime for these host pieces, so they are stood in by host elements named after them, which the tests read and press through their props.
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsAction: "SettingsAction",
  SettingsCard: "SettingsCard",
  SettingsInput: "SettingsInput",
  SettingsRow: "SettingsRow",
  SettingsSection: "SettingsSection",
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: (definition: unknown) => {
    host.settingsDefinition = definition;
    return useSyncExternalStore(
      (listener) => {
        host.listeners.add(listener);
        return () => {
          host.listeners.delete(listener);
        };
      },
      () => host.settings,
    );
  },
  // Validates both ways like the real `useRpc`, so every fixture is checked against the contract.
  useRpc: (contract: { input: Parser; output: Parser }) => {
    host.rpcContract = contract;
    return async (input: unknown) =>
      contract.output.parse(await host.rpc(contract.input.parse(input)));
  },
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Actions = Pick<EnvelopeSettings, "save" | "reset" | "reload">;

const save = vi.fn<Actions["save"]>();
const reset = vi.fn<Actions["reset"]>();
const reload = vi.fn<Actions["reload"]>();
const rpc = vi.fn<(input: unknown) => Promise<EnvFileStatus>>();

function setSettings(state: EnvelopeSettings) {
  host.settings = state;
  for (const listener of host.listeners) listener();
}

function common() {
  return { saving: false, saveError: null, save, reset, reload };
}

function ready(
  values: EnvelopeValues,
  revision = "r1",
  extra: Partial<Pick<ReadySettings, "saving" | "saveError">> = {},
): ReadySettings {
  return { status: "ready", values, revision, ...common(), ...extra };
}

const surface: PluginSurfaceProps = {
  theme: {
    colors: {
      surface0: "#000001",
      surface1: "#000002",
      surface2: "#000003",
      border: "#000004",
      foreground: "#000005",
      foregroundMuted: "#000006",
      accent: "#000007",
      accentForeground: "#000008",
      statusSuccess: "#000009",
      statusWarning: "#00000a",
      statusDanger: "#00000b",
    },
  },
  host: { id: "local", label: "Local" },
  layout: { compact: false, platform: "web" },
};

let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  save.mockReset();
  reset.mockReset();
  reload.mockReset();
  rpc.mockReset();
  reload.mockResolvedValue();
  host.rpc = rpc;
  // The row sets its own `retry`; no delay keeps a retried failure fast.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  root = createRoot();
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
});

/** Lets the RPC resolve and TanStack's batched notifications, scheduled on a timer, reach React. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

async function render(state: EnvelopeSettings) {
  host.settings = state;
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SettingsScreen {...surface} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function all(type: string): TestInstance[] {
  return root.container.queryAll((node) => node.type === type);
}

/** The element of `type` whose label or action label is `label`. */
function find(type: string, label: string): TestInstance {
  const found = all(type).filter(
    (node) => node.props["label"] === label || node.props["actionLabel"] === label,
  );
  expect(found, `${type} "${label}"`).toHaveLength(1);
  const [node] = found;
  assert.isDefined(node);
  return node;
}

function has(type: string, label: string): boolean {
  return all(type).some(
    (node) => node.props["label"] === label || node.props["actionLabel"] === label,
  );
}

function isCallable(value: unknown): value is (argument?: unknown) => unknown {
  return typeof value === "function";
}

async function call(node: TestInstance, name: string, argument?: unknown) {
  const handler: unknown = node.props[name];
  assert.isTrue(isCallable(handler), `${node.type} has no ${name}`);
  if (!isCallable(handler)) return;
  await act(async () => {
    handler(argument);
  });
  await settle();
}

const input = () => find("SettingsInput", "Path");
const type = (text: string) => call(input(), "onChangeText", text);
const press = (label: string) => call(find("SettingsAction", label), "onPress");
const statusRow = () => find("SettingsAction", "Refresh");

describe("settings states", () => {
  it("reads the plugin's settings document", async () => {
    await render({ status: "loading", ...common() });
    expect(host.settingsDefinition).toBe(envelopeSettings);
  });

  it("renders no saved value while loading", async () => {
    await render({ status: "loading", ...common() });

    expect(has("SettingsRow", "Loading settings…")).toBe(true);
    expect(all("SettingsInput")).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("shows a read error with a reload action", async () => {
    await render({ status: "error", error: "connection lost", ...common() });

    expect(find("SettingsAction", "Reload").props["error"]).toBe("connection lost");
    await press("Reload");
    expect(reload).toHaveBeenCalledOnce();
    expect(all("SettingsInput")).toHaveLength(0);
  });

  it("shows invalid settings with a reset action, and a failed reset", async () => {
    reset.mockResolvedValue(false);
    await render({
      status: "invalid",
      error: "envFile: expected string",
      revision: "r1",
      ...common(),
    });

    const action = find("SettingsAction", "Reset");
    expect(action.props["error"]).toBe("envFile: expected string");
    expect(action.props["disabled"]).toBe(false);
    await press("Reset");
    expect(reset).toHaveBeenCalledOnce();

    await act(async () =>
      setSettings({
        status: "invalid",
        error: "envFile: expected string",
        revision: "r1",
        ...common(),
        saveError: "reset failed",
      }),
    );
    expect(find("SettingsAction", "Reset").props["error"]).toBe("reset failed");
  });
});

describe("path editor", () => {
  beforeEach(() => {
    rpc.mockResolvedValue({ state: "ok", path: "/home/me/agents.env" });
  });

  it("seeds the input with the saved path and explains the rules", async () => {
    await render(ready({ envFile: "~/agents.env" }));

    expect(input().props).toMatchObject({
      initialValue: "~/agents.env",
      disabled: false,
      error: null,
    });
    expect(input().props["hint"]).toContain("next session open");
    expect(input().props["hint"]).toContain("Leave empty to inject nothing");
    expect(input().props["placeholder"]).toBe("e.g. ~/.env");
    expect(has("SettingsAction", "Save")).toBe(false);
  });

  it("seeds an empty input when no path is saved", async () => {
    await render(ready({}));
    expect(input().props["initialValue"]).toBe("");
  });

  it("saves a trimmed path against the revision captured when editing started", async () => {
    await render(ready({ envFile: "~/old.env" }, "r1"));
    await type("~/new");
    // Another client saves meanwhile: the draft keeps its revision and its input.
    await act(async () => setSettings(ready({ envFile: "~/other.env" }, "r2")));
    const before = input();
    await type(" ~/new.env ");
    expect(input()).toBe(before);

    save.mockImplementation(async (values) => {
      setSettings(ready(values, "r3"));
      return true;
    });
    expect(find("SettingsAction", "Save").props["disabled"]).toBe(false);
    await press("Save");

    expect(save).toHaveBeenCalledWith({ envFile: "~/new.env" }, "r1");
    expect(has("SettingsAction", "Save")).toBe(false);
    expect(input().props["initialValue"]).toBe("~/new.env");
  });

  it("clears the setting when the path is emptied", async () => {
    save.mockResolvedValue(true);
    await render(ready({ envFile: "~/old.env" }));

    await type("   ");
    await press("Save");

    // Strict, so a key left as `undefined` fails: the setting must be removed.
    expect(save.mock.lastCall).toStrictEqual([{}, "r1"]);
  });

  it("disables Save while the path is unchanged or saving", async () => {
    await render(ready({ envFile: "~/a.env" }));

    await type("~/a.env ");
    expect(find("SettingsAction", "Save").props["disabled"]).toBe(true);
    expect(has("SettingsAction", "No change")).toBe(true);

    await type("~/b.env");
    expect(has("SettingsAction", "Unsaved change")).toBe(true);
    await act(async () => setSettings(ready({ envFile: "~/a.env" }, "r1", { saving: true })));
    expect(find("SettingsAction", "Save").props["disabled"]).toBe(true);
    expect(input().props["disabled"]).toBe(true);
  });

  it("refuses a path that is not absolute", async () => {
    await render(ready({}));

    await type("agents.env");

    expect(input().props["error"]).toBe(envFilePathError("agents.env"));
    expect(find("SettingsAction", "Save").props["disabled"]).toBe(true);
  });

  it("keeps the draft and offers a reload when the save fails", async () => {
    save.mockImplementation(async () => {
      setSettings(ready({ envFile: "~/other.env" }, "r2", { saveError: "revision conflict" }));
      return false;
    });
    await render(ready({ envFile: "~/old.env" }));
    await type("~/new.env");
    const before = input();

    await press("Save");

    expect(input()).toBe(before);
    expect(input().props["error"]).toBe("revision conflict");
    const action = find("SettingsAction", "Reload");
    expect(action.props["label"]).toBe("Reload the saved settings");
    expect(action.props["hint"]).toContain("another client");

    await press("Reload");
    expect(reload).toHaveBeenCalledOnce();
    expect(has("SettingsAction", "Save")).toBe(false);
    expect(input()).not.toBe(before);
    expect(input().props["initialValue"]).toBe("~/other.env");
  });

  it("disables the controls while its save is in flight", async () => {
    let finish: (saved: boolean) => void = () => {};
    save.mockImplementation(async (values) => {
      setSettings(ready({ envFile: "~/old.env" }, "r1", { saving: true }));
      const saved = await new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      setSettings(ready(values, "r2"));
      return saved;
    });
    await render(ready({ envFile: "~/old.env" }));
    await type("~/new.env");

    await press("Save");

    expect(input().props["disabled"]).toBe(true);
    expect(find("SettingsAction", "Save").props["disabled"]).toBe(true);
    expect(find("SettingsAction", "Discard").props["disabled"]).toBe(true);
    await act(async () => finish(true));
    await settle();
    expect(has("SettingsAction", "Save")).toBe(false);
    expect(input().props).toMatchObject({ disabled: false, initialValue: "~/new.env" });
  });

  it("ignores a save error from another section's save", async () => {
    await render(ready({ envFile: "~/old.env" }));
    await type("~/new.env");

    await act(async () =>
      setSettings(ready({ envFile: "~/old.env" }, "r1", { saveError: "revision conflict" })),
    );

    expect(input().props["error"]).toBeNull();
    expect(has("SettingsAction", "Discard")).toBe(true);
    expect(has("SettingsAction", "Reload")).toBe(false);
  });

  it("drops its save error once a retried save succeeds", async () => {
    save.mockResolvedValueOnce(false);
    await render(ready({ envFile: "~/old.env" }, "r1", { saveError: "write failed" }));
    await type("~/new.env");
    await press("Save");
    expect(input().props["error"]).toBe("write failed");

    save.mockImplementationOnce(async (values) => {
      setSettings(ready(values, "r2"));
      return true;
    });
    await press("Save");
    expect(input().props["error"]).toBeNull();
    expect(has("SettingsAction", "Reload")).toBe(false);
  });

  it("discards a draft and reseeds the input", async () => {
    await render(ready({ envFile: "~/old.env" }));
    await type("~/new.env");
    const before = input();

    await press("Discard");

    expect(reload).toHaveBeenCalledOnce();
    expect(has("SettingsAction", "Save")).toBe(false);
    expect(input()).not.toBe(before);
  });

  it("follows a path saved elsewhere while there is no draft", async () => {
    await render(ready({ envFile: "~/old.env" }));

    await act(async () => setSettings(ready({ envFile: "~/other.env" }, "r2")));

    expect(input().props["initialValue"]).toBe("~/other.env");
  });
});

describe("status row", () => {
  async function statusFor(status: EnvFileStatus) {
    rpc.mockResolvedValue(status);
    await render(ready({}));
    return statusRow().props;
  }

  it("calls the status RPC with an empty input", async () => {
    await statusFor({ state: "ok", path: "/a" });

    expect(host.rpcContract).toBe(envFileStatus);
    expect(rpc).toHaveBeenCalledWith({});
  });

  it("shows a pending check without a result", async () => {
    rpc.mockReturnValue(new Promise(() => {}));
    await render(ready({}));

    expect(statusRow().props).toMatchObject({
      label: "Checking the file…",
      error: null,
      disabled: true,
    });
    expect(statusRow().props).not.toHaveProperty("hint");
  });

  it("shows the path in effect", async () => {
    expect(await statusFor({ state: "ok", path: "/home/me/a.env" })).toMatchObject({
      label: "File found",
      hint: "/home/me/a.env",
      error: null,
      disabled: false,
    });
    await act(async () => root.unmount());
    root = createRoot();
    queryClient.clear();
    const missing = await statusFor({ state: "missing", path: "/x/.env" });
    expect(missing).toMatchObject({ label: "File not found", hint: "/x/.env" });
    expect(missing["error"]).toContain("Nothing is injected");
  });

  it("shows an unset path as not configured, not as an error", async () => {
    expect(await statusFor({ state: "not-configured" })).toMatchObject({
      label: "Not configured",
      hint: "Set a path to inject its variables into new sessions.",
      error: null,
    });
  });

  it.each([
    [{ state: "not-file", path: "/d" }, "Not a regular file"],
    [{ state: "error", path: "/d", code: "EACCES" }, "File check failed: EACCES"],
    [{ state: "relative" }, "Path not absolute"],
    [{ state: "invalid-settings" }, "Settings invalid"],
    [{ state: "settings-unreadable" }, "Settings unreadable"],
    [{ state: "unresolved", code: "ENOENT" }, "Path can't be resolved: ENOENT"],
  ] satisfies [EnvFileStatus, string][])("shows %o as %s", async (status, label) => {
    const props = await statusFor(status);

    expect(props["label"]).toBe(label);
    expect(props["error"]).toContain("Nothing is injected");
  });

  it("retries a failed RPC once, then shows the failure with a refresh", async () => {
    rpc.mockRejectedValue(new Error("offline"));
    await render(ready({}));
    await settle();

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(statusRow().props["label"]).toBe("File check failed");
    expect(statusRow().props["error"]).toContain("couldn't");
  });

  it("strips unknown status keys and refuses a status that breaks the contract", async () => {
    host.rpc = async () => ({ state: "ok", path: "/a.env", content: 1 });
    await render(ready({}));
    await settle();
    expect(statusRow().props["label"]).toBe("File found");

    host.rpc = async () => ({ state: "error", path: "/a.env", code: "x=1" });
    await call(statusRow(), "onPress");
    await settle();
    expect(statusRow().props["label"]).toBe("File check failed");
  });

  it("checks again on refresh, and after a save", async () => {
    rpc.mockResolvedValue({ state: "missing", path: "/a.env" });
    await render(ready({ envFile: "/a.env" }));
    expect(statusRow().props["label"]).toBe("File not found");

    rpc.mockResolvedValue({ state: "ok", path: "/a.env" });
    await call(statusRow(), "onPress");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(statusRow().props["label"]).toBe("File found");

    rpc.mockResolvedValue({ state: "ok", path: "/b.env" });
    await act(async () => setSettings(ready({ envFile: "/b.env" }, "r2")));
    await settle();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(statusRow().props["hint"]).toBe("/b.env");
  });
});
