import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root, type TestInstance } from "test-renderer";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvFileStatus } from "../shared/env-file-status";
import type { EnvVarsList, EnvVarsReveal } from "../shared/env-vars";
import type { EnvelopeSettings, ReadySettings } from "./section";
import { SettingsScreen } from "./settings-screen";
import { MASK, VariablesSection } from "./variables-section";

interface Parser {
  parse(value: unknown): unknown;
}

/** The host-provided state this test drives: the settings document and one stub per RPC name. */
const host = vi.hoisted(() => {
  const state: { settings: unknown; rpcs: Map<string, (input: unknown) => Promise<unknown>> } = {
    settings: undefined,
    rpcs: new Map(),
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
  useSettings: () => host.settings,
  // Validates both ways like the real `useRpc`, so every fixture is checked against the contract.
  useRpc: (contract: { name: string; input: Parser; output: Parser }) => async (input: unknown) => {
    const stub = host.rpcs.get(contract.name);
    if (stub === undefined) throw new Error(`no stub for ${contract.name}`);
    return contract.output.parse(await stub(contract.input.parse(input)));
  },
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const listRpc = vi.fn<(input: unknown) => Promise<EnvVarsList>>();
const revealRpc = vi.fn<(input: unknown) => Promise<EnvVarsReveal>>();
const statusRpc = vi.fn<(input: unknown) => Promise<EnvFileStatus>>();

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

function ready(revision = "r1"): ReadySettings {
  return {
    status: "ready",
    values: { envFile: "/home/me/agents.env" },
    revision,
    saving: false,
    saveError: null,
    save: vi.fn<EnvelopeSettings["save"]>(),
    reset: vi.fn<EnvelopeSettings["reset"]>(),
    reload: vi.fn<EnvelopeSettings["reload"]>(),
  };
}

const SECRET = "s3cr3t-value";

const LIST: EnvVarsList = {
  state: "ok",
  path: "/home/me/agents.env",
  providers: "ok",
  variables: [
    { key: "API_TOKEN", status: { kind: "injected", overriddenBy: [] } },
    { key: "SHARED", status: { kind: "injected", overriddenBy: ["claude", "codex"] } },
    { key: "PATH", status: { kind: "protected" } },
  ],
};

/** A promise the test settles when it chooses, to deliver a response late. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  listRpc.mockReset();
  revealRpc.mockReset();
  statusRpc.mockReset();
  host.rpcs = new Map<string, (input: unknown) => Promise<unknown>>([
    ["env-vars.list", listRpc],
    ["env-vars.reveal", revealRpc],
    ["env-file.status", statusRpc],
  ]);
  listRpc.mockResolvedValue(LIST);
  // The section sets its own `retry`; no delay keeps a retried failure fast.
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

async function mount(element: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  await settle();
}

/** Navigates away: the section unmounts while the app keeps running. */
const leave = () => mount(null);

const render = (settings = ready()) => mount(<VariablesSection {...surface} settings={settings} />);

function all(type: string): TestInstance[] {
  return root.container.queryAll((node) => node.type === type);
}

function find(type: string, label: string): TestInstance {
  const found = all(type).filter((node) => node.props["label"] === label);
  expect(found, `${type} "${label}"`).toHaveLength(1);
  const [node] = found;
  assert.isDefined(node);
  return node;
}

const row = (key: string) => find("SettingsAction", key);
const header = () => {
  const [first] = all("SettingsAction");
  assert.isDefined(first);
  return first;
};

/** Every string any rendered element carries, to check a value is nowhere in the tree. */
function renderedText(): string {
  return root.container
    .queryAll(() => true)
    .flatMap((node) => Object.values(node.props).filter((value) => typeof value === "string"))
    .join("\n");
}

function isCallable(value: unknown): value is () => unknown {
  return typeof value === "function";
}

async function press(node: TestInstance) {
  const handler: unknown = node.props["onPress"];
  assert.isTrue(isCallable(handler), `${node.type} has no onPress`);
  if (!isCallable(handler)) return;
  await act(async () => {
    handler();
  });
  await settle();
}

describe("screen", () => {
  it("shows the variables after the environment file", async () => {
    host.settings = ready();
    statusRpc.mockResolvedValue({ state: "ok", path: "/home/me/agents.env" });

    await mount(<SettingsScreen {...surface} />);

    expect(all("SettingsSection").map((node): unknown => node.props["title"])).toEqual([
      "Environment file",
      "Variables",
    ]);
  });
});

describe("list", () => {
  it("lists the keys masked, with their status, from names only", async () => {
    await render();

    expect(listRpc).toHaveBeenCalledWith({});
    expect(header().props).toMatchObject({ label: "3 variables", actionLabel: "Refresh" });
    expect(header().props["hint"]).toContain("paseo run --env");
    expect(header().props["hint"]).not.toContain("couldn't be checked");
    expect(row("API_TOKEN").props).toMatchObject({
      hint: `Injected\n${MASK}`,
      actionLabel: "Show",
      error: null,
    });
    expect(row("SHARED").props["hint"]).toBe(
      `Injected, except for claude, codex: set in their provider env\n${MASK}`,
    );
    expect(row("PATH").props["hint"]).toBe(`Protected: never injected\n${MASK}`);
    expect(revealRpc).not.toHaveBeenCalled();
  });

  it("says when provider overrides couldn't be checked, and counts one variable", async () => {
    listRpc.mockResolvedValue({
      ...LIST,
      providers: "unavailable",
      variables: [{ key: "A", status: { kind: "injected", overriddenBy: [] } }],
    });

    await render();

    expect(header().props["label"]).toBe("1 variable");
    expect(header().props["hint"]).toContain("couldn't be checked");
  });

  it("shows a pending list without rows", async () => {
    listRpc.mockReturnValue(new Promise(() => {}));

    await render();

    expect(header().props).toMatchObject({ label: "Loading variables…", disabled: true });
    expect(header().props).not.toHaveProperty("hint");
    expect(all("SettingsAction")).toHaveLength(1);
    expect(all("SettingsRow")).toHaveLength(0);
  });

  it("retries once, then shows the failure", async () => {
    listRpc.mockRejectedValue(new Error("offline"));

    await render();
    // The retry runs on its own timer, after the first failure settled.
    await settle();

    expect(listRpc).toHaveBeenCalledTimes(2);
    expect(header().props).toMatchObject({ label: "Variables couldn't be listed" });
    expect(header().props["error"]).toContain("couldn't");
    expect(all("SettingsRow")).toHaveLength(0);
  });

  it.each<[string, EnvVarsList]>([
    ["an empty file", { state: "ok", path: "/a.env", providers: "ok", variables: [] }],
    ["no configured path", { state: "not-configured" }],
    ["a missing file", { state: "missing", path: "/a.env" }],
    ["a read error", { state: "error", path: "/a.env", code: "EACCES" }],
  ])("points to the path field for %s", async (_label, list) => {
    listRpc.mockResolvedValue(list);

    await render();

    expect(find("SettingsRow", "Nothing to list").props["hint"]).toContain("Environment file");
    expect(all("SettingsAction")).toHaveLength(1);
  });

  it("re-reads the list on Refresh", async () => {
    await render();
    listRpc.mockResolvedValue({ ...LIST, variables: [] });

    await press(header());

    expect(listRpc).toHaveBeenCalledTimes(2);
    expect(header().props["label"]).toBe("0 variables");
  });
});

describe("reveal", () => {
  it("fetches one value on Show and drops it on Hide", async () => {
    revealRpc.mockResolvedValue({ state: "ok", value: SECRET });
    await render();

    await press(row("API_TOKEN"));

    expect(revealRpc).toHaveBeenCalledExactlyOnceWith({ key: "API_TOKEN" });
    expect(row("API_TOKEN").props).toMatchObject({
      hint: `Injected\n${SECRET}`,
      actionLabel: "Hide",
    });
    expect(row("SHARED").props["hint"]).toContain(MASK);

    await press(row("API_TOKEN"));

    expect(row("API_TOKEN").props).toMatchObject({
      hint: `Injected\n${MASK}`,
      actionLabel: "Show",
    });
    expect(renderedText()).not.toContain(SECRET);
  });

  it("keeps every value out of the query and mutation caches", async () => {
    revealRpc.mockResolvedValue({ state: "ok", value: SECRET });
    await render();

    await press(row("API_TOKEN"));
    expect(renderedText()).toContain(SECRET);

    const cached = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data);
    expect(cached).toEqual([LIST]);
    expect(JSON.stringify(cached)).not.toContain(SECRET);
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
  });

  it("shows a pending reveal, which a second press cancels", async () => {
    const late = deferred<EnvVarsReveal>();
    revealRpc.mockReturnValue(late.promise);
    await render();

    await press(row("API_TOKEN"));
    expect(row("API_TOKEN").props).toMatchObject({ hint: "Injected\n…", actionLabel: "Hide" });

    await press(row("API_TOKEN"));
    await act(async () => late.resolve({ state: "ok", value: SECRET }));
    await settle();

    expect(row("API_TOKEN").props).toMatchObject({
      hint: `Injected\n${MASK}`,
      actionLabel: "Show",
    });
    expect(renderedText()).not.toContain(SECRET);
  });

  it("drops a late response once the row was pressed again", async () => {
    const first = deferred<EnvVarsReveal>();
    revealRpc.mockReturnValueOnce(first.promise);
    revealRpc.mockResolvedValueOnce({ state: "ok", value: "second" });
    await render();

    await press(row("API_TOKEN"));
    await press(row("API_TOKEN"));
    await press(row("API_TOKEN"));
    await act(async () => first.resolve({ state: "ok", value: SECRET }));
    await settle();

    expect(row("API_TOKEN").props["hint"]).toBe("Injected\nsecond");
    expect(renderedText()).not.toContain(SECRET);
  });

  it("drops a late failure too", async () => {
    const late = deferred<EnvVarsReveal>();
    revealRpc.mockReturnValue(late.promise);
    await render();

    await press(row("API_TOKEN"));
    await press(row("API_TOKEN"));
    await act(async () => late.reject(new Error("offline")));
    await settle();

    expect(row("API_TOKEN").props["error"]).toBeNull();
  });

  it("drops a response that arrives after the screen is left", async () => {
    const late = deferred<EnvVarsReveal>();
    revealRpc.mockReturnValue(late.promise);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await render();
    await press(row("API_TOKEN"));

    await leave();
    await act(async () => late.resolve({ state: "ok", value: SECRET }));
    await settle();

    expect(root.container.queryAll(() => true)).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it("renders nothing of a shown value after the screen is left", async () => {
    revealRpc.mockResolvedValue({ state: "ok", value: SECRET });
    await render();
    await press(row("API_TOKEN"));

    await leave();

    expect(root.container.queryAll(() => true)).toHaveLength(0);
  });

  it("hides every value when the list is refreshed", async () => {
    revealRpc.mockResolvedValue({ state: "ok", value: SECRET });
    await render();
    await press(row("API_TOKEN"));
    await press(row("PATH"));
    expect(renderedText()).toContain(SECRET);

    await press(header());

    expect(listRpc).toHaveBeenCalledTimes(2);
    expect(row("API_TOKEN").props["actionLabel"]).toBe("Show");
    expect(row("PATH").props["actionLabel"]).toBe("Show");
    expect(renderedText()).not.toContain(SECRET);
  });

  it("hides every value when the settings change", async () => {
    revealRpc.mockResolvedValue({ state: "ok", value: SECRET });
    await render();
    await press(row("API_TOKEN"));

    await render(ready("r2"));

    expect(listRpc).toHaveBeenCalledTimes(2);
    expect(row("API_TOKEN").props["actionLabel"]).toBe("Show");
    expect(renderedText()).not.toContain(SECRET);
  });

  it.each<[string, () => Promise<EnvVarsReveal>, string]>([
    [
      "a rejection",
      async () => {
        throw new Error(SECRET);
      },
      "couldn't be asked",
    ],
    ["a removed key", async () => ({ state: "not-found" }), "No longer in the file"],
    ["an unreadable file", async () => ({ state: "unavailable" }), "can't be read right now."],
    [
      "an unreadable file with a code",
      async () => ({ state: "unavailable", code: "ENOENT" }),
      "can't be read right now: ENOENT",
    ],
  ])("shows %s as an error on the row, without a value", async (_label, response, message) => {
    revealRpc.mockImplementation(response);
    await render();

    await press(row("SHARED"));

    expect(row("SHARED").props).toMatchObject({
      hint: `Injected, except for claude, codex: set in their provider env\n${MASK}`,
      actionLabel: "Show",
    });
    expect(row("SHARED").props["error"]).toContain(message);
    expect(renderedText()).not.toContain(SECRET);

    revealRpc.mockResolvedValue({ state: "ok", value: "fixed" });
    await press(row("SHARED"));
    expect(row("SHARED").props["error"]).toBeNull();
  });
});
