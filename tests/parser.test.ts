import { describe, expect, it } from "vitest";
import {
  EnvParseError,
  expandEscapes,
  findCommentHash,
  formatValue,
  isValidKey,
  parseEnvText,
  stripBom,
  toRecord,
} from "../src/parser.js";

describe("parseEnvText - core grammar", () => {
  it("parses plain key=value pairs and keeps them in file order", () => {
    const file = parseEnvText("A=1\nB=2\nC=3\n");
    expect(file.entries.map((e) => e.key)).toEqual(["A", "B", "C"]);
    expect(file.entries.map((e) => e.value)).toEqual(["1", "2", "3"]);
    expect(file.entries.map((e) => e.line)).toEqual([1, 2, 3]);
  });

  it("supports the export prefix and records it", () => {
    const file = parseEnvText("export PORT=3000\nexport  DATABASE_URL=postgres://x\n");
    expect(file.entries[0]).toMatchObject({ key: "PORT", value: "3000", exported: true });
    expect(file.entries[1]).toMatchObject({ key: "DATABASE_URL", value: "postgres://x", exported: true });
  });

  it("strips single and double quotes from the value but keeps rawValue", () => {
    const file = parseEnvText('A="hello world"\nB=\'raw things\'\n');
    expect(file.entries[0]).toMatchObject({ key: "A", value: "hello world", quote: "double", rawValue: '"hello world"' });
    expect(file.entries[1]).toMatchObject({ key: "B", value: "raw things", quote: "single" });
  });

  it("treats an unescaped # as a comment but keeps it inside quotes", () => {
    const file = parseEnvText('A=value # trailing comment\nB="has # hash"\nC=no#hash\n');
    expect(file.entries[0]?.value).toBe("value");
    expect(file.entries[1]?.value).toBe("has # hash");
    expect(file.entries[2]?.value).toBe("no");
  });

  it("keeps an escaped # inside an unquoted value", () => {
    const file = parseEnvText("A=value\\#notacomment\n");
    expect(file.entries[0]?.value).toBe("value#notacomment");
  });

  it("expands escape sequences only for double quoted values", () => {
    const file = parseEnvText('A="line1\\nline2"\nB=\'line1\\nline2\'\n');
    expect(file.entries[0]?.value).toBe("line1\nline2");
    expect(file.entries[1]?.value).toBe("line1\\nline2");
  });

  it("folds multi-line quoted values into one entry", () => {
    const file = parseEnvText('KEY="first\nsecond\nthird"\nNEXT=1\n');
    expect(file.entries).toHaveLength(2);
    expect(file.entries[0]?.value).toBe("first\nsecond\nthird");
    expect(file.entries[1]).toMatchObject({ key: "NEXT", line: 4 });
  });

  it("attaches leading comment lines to the assignment below them", () => {
    const file = parseEnvText("# Database\n# local only\nDB_URL=postgres://localhost\n");
    expect(file.entries[0]?.comments).toEqual(["# Database", "# local only"]);
  });

  it("handles CRLF and records the newline style", () => {
    const file = parseEnvText("A=1\r\nB=2\r\n");
    expect(file.newline).toBe("\r\n");
    expect(file.entries.map((e) => e.key)).toEqual(["A", "B"]);
    expect(file.entries[1]?.value).toBe("2");
  });

  it("strips a UTF-8 BOM before parsing the first key", () => {
    const file = parseEnvText("\uFEFFA=1\n");
    expect(file.hasBom).toBe(true);
    expect(file.entries[0]?.key).toBe("A");
  });

  it("records empty values instead of dropping the entry", () => {
    const file = parseEnvText("EMPTY=\nQUOTED_EMPTY=\"\"\n");
    expect(file.entries.map((e) => e.key)).toEqual(["EMPTY", "QUOTED_EMPTY"]);
    expect(file.entries[0]?.value).toBe("");
    expect(file.entries[1]?.value).toBe("");
  });

  it("reports duplicate keys with every line number", () => {
    const file = parseEnvText("A=1\nB=2\nA=3\n");
    expect(file.duplicates).toHaveLength(1);
    expect(file.duplicates[0]).toEqual({ key: "A", lines: [1, 3] });
    expect(toRecord(file).get("A")?.value).toBe("3");
  });

  it("collects invalid lines and only throws in strict mode", () => {
    const lenient = parseEnvText("A=1\nthis is not valid\nB=2\n");
    expect(lenient.invalid).toHaveLength(1);
    expect(lenient.invalid[0]).toEqual({ line: 2, text: "this is not valid" });
    expect(() => parseEnvText("A=1\nnot valid\n", { strict: true })).toThrow(EnvParseError);
  });

  it("throws on an unterminated quote in strict mode", () => {
    expect(() => parseEnvText('KEY="never closed\n', { strict: true })).toThrow(/unterminated/);
  });

  it("ignores blank lines and comment-only lines", () => {
    const file = parseEnvText("\n# just a comment\n\n\nA=1\n\n");
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]?.key).toBe("A");
  });
});

describe("helpers", () => {
  it("stripBom removes only a leading BOM", () => {
    expect(stripBom("\uFEFFabc")).toBe("abc");
    expect(stripBom("abcd")).toBe("abcd");
  });

  it("expandEscapes understands the common sequences", () => {
    expect(expandEscapes("a\\nb")).toBe("a\nb");
    expect(expandEscapes("a\\tb")).toBe("a\tb");
    expect(expandEscapes("a\\\\b")).toBe("a\\b");
    expect(expandEscapes("a\\qb")).toBe("a\\qb");
  });

  it("findCommentHash ignores escaped hashes and quoted content is handled by the caller", () => {
    expect(findCommentHash("value # comment")).toBe(6);
    expect(findCommentHash("value \\# hash")).toBe(-1);
    expect(findCommentHash("no hash here")).toBe(-1);
  });

  it("formatValue round-trips through the parser", () => {
    const value = "hello world";
    const line = "A=" + formatValue(value, "none");
    expect(parseEnvText(line).entries[0]?.value).toBe(value);
    expect(parseEnvText("A=" + formatValue(value, "double")).entries[0]?.value).toBe(value);
    expect(parseEnvText("A=" + formatValue(value, "single")).entries[0]?.value).toBe(value);
  });

  it("isValidKey accepts dotted keys and rejects invalid ones", () => {
    expect(isValidKey("A")).toBe(true);
    expect(isValidKey("A.B_C-1")).toBe(true);
    expect(isValidKey("1A")).toBe(false);
    expect(isValidKey("A B")).toBe(false);
    expect(isValidKey("")).toBe(false);
  });
});
