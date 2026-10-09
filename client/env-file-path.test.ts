import { describe, expect, it } from "vitest";

import { childPath, envFilePathError, withEnvFile } from "./env-file-path";
import { run } from "./run";

describe("path helpers", () => {
  it.each(["", "  ", "~", "~/a.env", "/a.env", "C:\\a.env", "c:/a.env", "\\\\server\\share\\.env"])(
    "accepts %j",
    (path) => {
      expect(envFilePathError(path)).toBeNull();
    },
  );

  it.each(["a.env", "./a.env", "~a.env", "~user/a.env", "C:a.env", "\\a.env"])(
    "refuses %j",
    (path) => {
      expect(envFilePathError(path)).toMatch(/absolute/u);
    },
  );

  it("keeps the other values and removes an emptied setting", () => {
    expect(withEnvFile({ envFile: "/a" }, " /b ")).toEqual({ envFile: "/b" });
    expect(withEnvFile({ envFile: "/a" }, "")).toEqual({});
  });

  it("joins a name onto a listed directory without doubling the separator", () => {
    expect(childPath("~", "/", ".env")).toBe("~/.env");
    expect(childPath("~", "\\", ".env")).toBe("~/.env");
    expect(childPath("~/a", "/", ".env")).toBe("~/a/.env");
    expect(childPath("/", "/", "etc")).toBe("/etc");
    expect(childPath("C:\\", "\\", "a.env")).toBe("C:\\a.env");
    expect(childPath("C:\\Users", "\\", "a.env")).toBe("C:\\Users\\a.env");
  });

  it("swallows a rejected action, which reports through its own state", async () => {
    const rejected = Promise.reject(new Error("failed"));
    run(rejected);
    await expect(rejected).rejects.toThrow("failed");
  });
});
