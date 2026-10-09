import type { ModalProps } from "@getpaseo/plugin/client/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root, type TestInstance } from "test-renderer";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import { BROWSE_ENTRY_CAP, envFileBrowse, type EnvFileBrowse } from "../shared/env-file-browse";
import { EnvFileBrowser } from "./env-file-browser";

interface Parser {
  parse(value: unknown): unknown;
}

/** The browse RPC handler this test drives. */
const host = vi.hoisted(() => {
  const state: { browse: (input: unknown) => Promise<unknown>; contract: unknown } = {
    browse: async () => {
      throw new Error("no RPC stub");
    },
    contract: undefined,
  };
  return state;
});

// Host pieces stood in by host elements named after them, read and pressed through their props, as in the settings screen test.
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsAction: "SettingsAction",
  SettingsCard: "SettingsCard",
  SettingsRow: "SettingsRow",
}));

// Renders its children only while open, like the host's sheet or dialog.
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const { createElement } = await import("react");
  function Modal({ open, children, ...props }: ModalProps) {
    return open ? createElement("Modal", props, children) : null;
  }
  return { Modal: Object.assign(Modal, { Content: "ModalContent" }) };
});

// Validates both ways like the real `useRpc`, so every fixture is checked against the contract.
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { input: Parser; output: Parser }) => {
    host.contract = contract;
    return async (input: unknown) =>
      contract.output.parse(await host.browse(contract.input.parse(input)));
  },
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const browse = vi.fn<(input: unknown) => Promise<EnvFileBrowse>>();
const onOpenChange = vi.fn<(open: boolean) => void>();
const onPick = vi.fn<(path: string) => void>();

let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  browse.mockReset();
  onOpenChange.mockReset();
  onPick.mockReset();
  host.browse = browse;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  root = createRoot();
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

async function render(open = true, start = "~/a/.env") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <EnvFileBrowser open={open} start={start} onOpenChange={onOpenChange} onPick={onPick} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function all(type: string): TestInstance[] {
  return root.container.queryAll((node) => node.type === type);
}

/** The rows in the picker, as `type label [actionLabel]`, to read the listing at a glance. */
function rows(): string[] {
  return root.container
    .queryAll((node) => node.type === "SettingsAction" || node.type === "SettingsRow")
    .map((node) => {
      const action: unknown = node.props["actionLabel"];
      const label = `${node.type} ${String(node.props["label"])}`;
      return typeof action === "string" ? `${label} [${action}]` : label;
    });
}

function find(type: string, label: string): TestInstance {
  const found = all(type).filter((node) => node.props["label"] === label);
  expect(found, `${type} "${label}"`).toHaveLength(1);
  const [node] = found;
  assert.isDefined(node);
  return node;
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

const press = (node: TestInstance) => call(node, "onPress");

function listing(overrides: Partial<Extract<EnvFileBrowse, { state: "ok" }>> = {}): EnvFileBrowse {
  return {
    state: "ok",
    path: "/home/me/a",
    display: "~/a",
    parent: "~",
    separator: "/",
    entries: [],
    total: 0,
    ...overrides,
  };
}

describe("env file browser", () => {
  it("lists nothing while closed", async () => {
    browse.mockResolvedValue(listing());
    await render(false);

    expect(all("Modal")).toHaveLength(0);
    expect(browse).not.toHaveBeenCalled();
  });

  it("opens at the start path's folder, in a host modal", async () => {
    browse.mockReturnValue(new Promise(() => {}));
    await render();

    expect(host.contract).toBe(envFileBrowse);
    expect(browse).toHaveBeenCalledWith({ path: "~/a/.env", containing: true });
    const [modal] = all("Modal");
    expect(modal?.props["title"]).toBe("Choose the .env file");
    expect(all("ModalContent")).toHaveLength(1);
    expect(rows()).toEqual(["SettingsRow Loading…"]);
  });

  it("passes dismissal to the owner", async () => {
    browse.mockResolvedValue(listing());
    await render();

    const [modal] = all("Modal");
    assert.isDefined(modal);
    await call(modal, "onOpenChange", false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows each kind of entry with what can be done with it", async () => {
    browse.mockResolvedValue(
      listing({
        entries: [
          { name: "projects", kind: "directory" },
          { name: "work", kind: "symlink", target: "directory" },
          { name: ".env", kind: "file" },
          { name: "broken", kind: "symlink", target: "missing" },
          { name: "dev", kind: "symlink", target: "other" },
          { name: "linked.env", kind: "symlink", target: "file" },
          { name: "slow", kind: "symlink", target: "unknown" },
          { name: "pipe", kind: "other" },
        ],
        total: 7,
      }),
    );
    await render();

    expect(rows()).toEqual([
      "SettingsRow ~/a",
      "SettingsAction Parent folder [Up]",
      "SettingsAction projects/ [Open]",
      "SettingsAction work/ [Open]",
      "SettingsAction .env [Choose]",
      "SettingsRow broken",
      "SettingsRow dev",
      "SettingsAction linked.env [Choose]",
      "SettingsRow slow",
      "SettingsRow pipe",
    ]);
    expect(find("SettingsRow", "~/a").props["hint"]).toContain("daemon");
    expect(find("SettingsAction", "work/").props["hint"]).toBe("Link");
    expect(find("SettingsAction", "linked.env").props["hint"]).toBe("Link");
    expect(find("SettingsAction", ".env").props).not.toHaveProperty("hint");
    expect(find("SettingsRow", "broken").props["hint"]).toBe("Broken link, can't be chosen.");
    expect(find("SettingsRow", "dev").props["hint"]).toBe(
      "Link to something that isn't a file, can't be chosen.",
    );
    expect(find("SettingsRow", "slow").props["hint"]).toBe(
      "Not checked in time. Type the path to use it.",
    );
    expect(find("SettingsRow", "pipe").props["hint"]).toBe("Not a regular file, can't be chosen.");
  });

  it("says when a folder is empty, and when its listing is truncated", async () => {
    browse.mockResolvedValue(listing());
    await render();
    expect(rows()).toContain("SettingsRow This folder is empty");

    browse.mockResolvedValue(
      listing({ entries: [{ name: "a", kind: "file" }], total: BROWSE_ENTRY_CAP + 20 }),
    );
    await press(find("SettingsAction", "Parent folder"));
    expect(rows()).toContain(
      `SettingsRow Showing the first ${BROWSE_ENTRY_CAP} of ${BROWSE_ENTRY_CAP + 20} entries`,
    );
    expect(rows()).not.toContain("SettingsRow This folder is empty");
  });

  it("opens a folder and goes up", async () => {
    browse.mockResolvedValue(listing({ entries: [{ name: "b", kind: "directory" }], total: 1 }));
    await render();

    await press(find("SettingsAction", "b/"));
    expect(browse).toHaveBeenLastCalledWith({ path: "~/a/b" });

    await press(find("SettingsAction", "Parent folder"));
    expect(browse).toHaveBeenLastCalledWith({ path: "~" });
  });

  it("can't go up from the root, and joins names there without doubling the separator", async () => {
    browse.mockResolvedValue(
      listing({
        path: "/",
        display: "/",
        parent: null,
        entries: [
          { name: "etc", kind: "directory" },
          { name: "a.env", kind: "file" },
        ],
        total: 2,
      }),
    );
    await render();

    const up = find("SettingsAction", "Parent folder");
    expect(up.props["disabled"]).toBe(true);
    await press(up);
    expect(browse).toHaveBeenCalledOnce();

    await press(find("SettingsAction", "a.env"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPick).toHaveBeenCalledWith("/a.env");

    await press(find("SettingsAction", "etc/"));
    expect(browse).toHaveBeenLastCalledWith({ path: "/etc" });
  });

  it("picks a file in display form and closes", async () => {
    browse.mockResolvedValue(listing({ entries: [{ name: ".env", kind: "file" }], total: 1 }));
    await render();

    await press(find("SettingsAction", ".env"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPick).toHaveBeenCalledWith("~/a/.env");
  });

  it.each([
    [{ state: "missing", path: "/home/me/gone" }, "Folder not found", "/home/me/gone"],
    [{ state: "not-directory", path: "/home/me/f" }, "Not a folder", "/home/me/f"],
    [{ state: "relative" }, "Path not absolute", undefined],
  ] satisfies [EnvFileBrowse, string, string | undefined][])(
    "shows %o as %s, with a way home",
    async (result, label, hint) => {
      browse.mockResolvedValueOnce(result).mockResolvedValue(listing({ display: "~" }));
      await render();

      const row = find("SettingsAction", label);
      expect(row.props["hint"]).toBe(hint);
      expect(row.props["actionLabel"]).toBe("Go to home");
      await press(row);
      expect(browse).toHaveBeenLastCalledWith({ path: "" });
      expect(rows()[0]).toBe("SettingsRow ~");
    },
  );

  it("offers Retry and Go to home when a folder can't be listed", async () => {
    browse
      .mockResolvedValueOnce({ state: "error", path: "/home/me/a", code: "EBUSY" })
      .mockResolvedValueOnce({ state: "error", path: "/home/me/a", code: "EBUSY" })
      .mockResolvedValue(listing());
    await render();

    expect(rows()).toEqual([
      "SettingsAction Couldn't list the folder: EBUSY [Retry]",
      "SettingsAction Start from the home folder [Go to home]",
    ]);
    expect(find("SettingsAction", "Couldn't list the folder: EBUSY").props).toMatchObject({
      hint: "/home/me/a",
      disabled: false,
    });
    await press(find("SettingsAction", "Couldn't list the folder: EBUSY"));
    expect(browse).toHaveBeenCalledTimes(2);
    expect(browse).toHaveBeenLastCalledWith({ path: "~/a/.env", containing: true });

    await press(find("SettingsAction", "Start from the home folder"));
    expect(browse).toHaveBeenLastCalledWith({ path: "" });
    expect(rows()[0]).toBe("SettingsRow ~/a");
  });

  it("only offers Retry for an error at home, until it succeeds", async () => {
    browse
      .mockResolvedValueOnce({ state: "error", path: "/home/me", code: "EACCES" })
      .mockResolvedValueOnce({ state: "error", path: "/home/me", code: "ETIMEDOUT" })
      .mockResolvedValue(listing({ display: "~" }));
    await render(true, "");

    expect(browse).toHaveBeenCalledWith({ path: "", containing: true });
    expect(rows()).toEqual(["SettingsAction Couldn't list the folder: EACCES [Retry]"]);
    await press(find("SettingsAction", "Couldn't list the folder: EACCES"));
    expect(rows()).toEqual(["SettingsAction Couldn't list the folder: ETIMEDOUT [Retry]"]);
    await press(find("SettingsAction", "Couldn't list the folder: ETIMEDOUT"));
    expect(rows()[0]).toBe("SettingsRow ~");
  });

  it("offers Retry instead of Go to home for a missing home", async () => {
    browse.mockResolvedValue({ state: "missing", path: "/home/me" });
    await render(true, "");

    expect(rows()).toEqual(["SettingsAction Folder not found [Retry]"]);
    await press(find("SettingsAction", "Folder not found"));
    expect(browse).toHaveBeenCalledTimes(2);
  });

  it("shows a home that can't be resolved, with nowhere to go", async () => {
    browse.mockResolvedValue({ state: "unresolved", code: "ENOENT" });
    await render();

    expect(rows()).toEqual(["SettingsRow Home folder can't be resolved: ENOENT"]);
    expect(find("SettingsRow", "Home folder can't be resolved: ENOENT").props["error"]).toContain(
      "Type the path",
    );
  });

  it("retries a failed RPC once, then offers Retry", async () => {
    browse.mockRejectedValue(new Error("offline"));
    await render();
    await settle();

    expect(browse).toHaveBeenCalledTimes(2);
    const failed = find("SettingsAction", "Couldn't list the folder");
    expect(failed.props).toMatchObject({ actionLabel: "Retry", disabled: false });
    expect(failed.props["error"]).toContain("couldn't");

    browse.mockResolvedValue(listing());
    await press(failed);
    expect(rows()[0]).toBe("SettingsRow ~/a");
  });

  it("refuses a listing that breaks the contract", async () => {
    // A code that isn't identifier-shaped could carry a value.
    host.browse = async () => ({ state: "error", path: "/a", code: "x=1" });
    await render();
    await settle();

    expect(rows()).toEqual(["SettingsAction Couldn't list the folder [Retry]"]);
  });
});
