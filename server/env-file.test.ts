import { afterEach, describe, expect, it, vi } from "vitest";

import { parseEnvFile } from "./env-file";

const noop = () => {};
const accepted = () => true;

function spyOnOutput() {
  return [
    vi.spyOn(console, "log").mockImplementation(noop),
    vi.spyOn(console, "info").mockImplementation(noop),
    vi.spyOn(console, "warn").mockImplementation(noop),
    vi.spyOn(console, "error").mockImplementation(noop),
    vi.spyOn(console, "debug").mockImplementation(noop),
    vi.spyOn(process.stdout, "write").mockImplementation(accepted),
    vi.spyOn(process.stderr, "write").mockImplementation(accepted),
  ];
}

describe("assignments", () => {
  it("reads KEY=value", () => {
    expect(parseEnvFile("KEY=value")).toEqual({ KEY: "value" });
  });

  it("accepts an export prefix", () => {
    expect(parseEnvFile("export KEY=value")).toEqual({ KEY: "value" });
  });

  it("ignores whitespace around the key and the equals sign", () => {
    expect(parseEnvFile("  KEY  =  value")).toEqual({ KEY: "value" });
  });

  it("accepts KEY: value", () => {
    expect(parseEnvFile("KEY: value")).toEqual({ KEY: "value" });
  });

  it("skips KEY:value without a space after the colon", () => {
    expect(parseEnvFile("KEY:value")).toEqual({});
  });

  it("keeps equals signs inside the value", () => {
    expect(parseEnvFile("E=a=b")).toEqual({ E: "a=b" });
  });

  it("keeps the last value of a duplicate key", () => {
    expect(parseEnvFile("A=1\nA=2")).toEqual({ A: "2" });
  });
});

describe("empty lines and comments", () => {
  it("ignores empty and comment lines", () => {
    expect(parseEnvFile("\n\n# comment\nA=1\n  # indented\n")).toEqual({ A: "1" });
  });

  it("reads KEY= as an empty string", () => {
    expect(parseEnvFile("KEY=")).toEqual({ KEY: "" });
  });

  it("reads KEY= #comment as an empty string", () => {
    expect(parseEnvFile("KEY= #c")).toEqual({ KEY: "" });
  });
});

describe("unquoted values", () => {
  it("starts a comment at # even without a preceding space", () => {
    expect(parseEnvFile("C=a#b\nD=a #b")).toEqual({ C: "a", D: "a" });
  });

  it("trims trailing whitespace", () => {
    expect(parseEnvFile("C=abc   ")).toEqual({ C: "abc" });
  });

  it("keeps $VAR, ${VAR} and $(cmd) literal", () => {
    expect(parseEnvFile("U=$X ${Y} $(id)")).toEqual({ U: "$X ${Y} $(id)" });
  });
});

describe("quoted values", () => {
  it("keeps single-quoted content literal", () => {
    expect(parseEnvFile("S='a\\nb $X ${Y} $(id) #c'")).toEqual({ S: "a\\nb $X ${Y} $(id) #c" });
  });

  it("keeps backtick content literal", () => {
    expect(parseEnvFile("B=`a\\nb $X ${Y} $(id) #c`")).toEqual({ B: "a\\nb $X ${Y} $(id) #c" });
  });

  it("expands only \\n and \\r in double quotes", () => {
    expect(parseEnvFile('D="a\\nb\\rc\\td\\\\e\\"f $X ${Y} $(id) #c"')).toEqual({
      D: 'a\nb\rc\\td\\\\e\\"f $X ${Y} $(id) #c',
    });
  });

  it("spans lines in every quote style", () => {
    expect(parseEnvFile("D=\"m\nl\"\nS='m\nl'\nB=`m\nl`")).toEqual({
      D: "m\nl",
      S: "m\nl",
      B: "m\nl",
    });
  });

  it("keeps an unterminated quote raw", () => {
    expect(parseEnvFile("F=\"unterm\nG='unterm\nH=1")).toEqual({
      F: '"unterm',
      G: "'unterm",
      H: "1",
    });
  });

  it("keeps the raw text when content follows the closing quote", () => {
    expect(parseEnvFile('K="q" trailing')).toEqual({ K: '"q" trailing' });
  });

  it("allows a comment after the closing quote", () => {
    expect(parseEnvFile('K="q" # c')).toEqual({ K: "q" });
  });

  it("keeps a quote inside an unquoted value", () => {
    expect(parseEnvFile('Q=a"b')).toEqual({ Q: 'a"b' });
  });
});

describe("encoding", () => {
  it("accepts CRLF line endings", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  it("normalizes CRLF inside a quoted value to \\n", () => {
    expect(parseEnvFile('A="x\r\ny"\r\nB=2')).toEqual({ A: "x\ny", B: "2" });
  });

  it("ignores a leading BOM", () => {
    expect(parseEnvFile("\uFEFFA=1")).toEqual({ A: "1" });
  });
});

describe("keys", () => {
  it("accepts word characters, dots and dashes", () => {
    expect(parseEnvFile("1X=a\nM.N-O=b")).toEqual({ "1X": "a", "M.N-O": "b" });
  });

  it("skips malformed lines without affecting neighbors", () => {
    expect(parseEnvFile("A=1\nbad line\n@KEY=1\nKEY WITH SPACE=1\nexport\nB=2")).toEqual({
      A: "1",
      B: "2",
    });
  });
});

describe("prototype safety", () => {
  it("drops __proto__ without polluting Object.prototype", () => {
    const result = parseEnvFile("__proto__=x\nA=1");

    expect(result).toEqual({ A: "1" });
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "x")).toBe(false);
  });

  it("returns a plain object", () => {
    const result = parseEnvFile("A=1");

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.keys(result)).toEqual(["A"]);
  });
});

describe("secrecy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never leaks a value", () => {
    const spies = spyOnOutput();
    const skipped = {
      badLine: "s3cr3t-bad-line",
      atKey: "s3cr3t-at-key",
      spacedKey: "s3cr3t-spaced-key",
      colonNoSpace: "s3cr3t-colon-no-space",
      proto: "s3cr3t-proto",
      quotedProto: "s3cr3t-quoted-proto",
    };
    const content = [
      `bad line ${skipped.badLine}`,
      `@KEY=${skipped.atKey}`,
      `KEY WITH SPACE=${skipped.spacedKey}`,
      `KEY:${skipped.colonNoSpace}`,
      `__proto__=${skipped.proto}`,
      `__proto__="${skipped.quotedProto}"`,
      'UNTERM="s3cr3t-unterminated',
      'TRAILING="s3cr3t-trailing" junk',
      "UNQUOTED=s3cr3t-unquoted#s3cr3t-comment",
      "MULTI='s3cr3t-multi",
      "line'",
    ].join("\n");

    let result: Record<string, string> = {};
    expect(() => {
      result = parseEnvFile(content);
    }).not.toThrow();

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
    const values = Object.values(result).join("\n");
    for (const sentinel of Object.values(skipped)) {
      expect(values).not.toContain(sentinel);
    }
  });
});
