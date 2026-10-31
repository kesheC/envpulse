import { readFileSync } from "node:fs";
import { closesPemBlock, isPemBodyLine, opensPemBlock } from "./rules.js";
import type { DuplicateKey, EnvEntry, EnvFile, InvalidLine, Quote } from "./types.js";
import { describeInvalidLine, shortDigest } from "./util.js";

const KEY_SRC = "[A-Za-z_][A-Za-z0-9_.-]*";
const KEY_RE = new RegExp("^" + KEY_SRC + "$");
const ASSIGN_RE = new RegExp("^\\s*(export\\s+)?" + "(" + KEY_SRC + ")" + "\\s*=\\s*([\\s\\S]*)$");

export class EnvParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = "EnvParseError";
    this.line = line;
  }
}

export interface ParseOptions {
  /** Path recorded on the result, used in messages. */
  path?: string;
  /** Throw on malformed lines instead of collecting them into `invalid`. */
  strict?: boolean;
}

/** Strip a UTF-8 BOM if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Detect the dominant newline style of a buffer. */
export function detectNewline(text: string): "\n" | "\r\n" {
  const first = text.indexOf("\n");
  if (first > 0 && text.charCodeAt(first - 1) === 13) return "\r\n";
  return "\n";
}

function countTrailingBackslashes(text: string): number {
  let n = 0;
  for (let i = text.length - 1; i >= 0 && text.charAt(i) === "\\"; i--) n += 1;
  return n;
}

/** Expand escape sequences inside a double quoted value. */
export function expandEscapes(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value.charAt(i + 1);
    if (next === "") {
      out += "\\";
      break;
    }
    i += 1;
    switch (next) {
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "f": out += "\f"; break;
      case "b": out += "\b"; break;
      case "v": out += "\v"; break;
      case "0": out += "\u0000"; break;
      case "\\": out += "\\"; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case "$": out += "$"; break;
      default: out += "\\" + next; break;
    }
  }
  return out;
}

/** Index of the first unescaped `#` in an unquoted value, or -1. */
export function findCommentHash(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) !== "#") continue;
    if (countTrailingBackslashes(text.slice(0, i)) % 2 === 1) continue;
    return i;
  }
  return -1;
}

/** Index of the quote that closes the value starting at index 0, or -1. */
function findClosingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text.charAt(i) !== quote) continue;
    if (quote === "'") return i;
    if (countTrailingBackslashes(text.slice(0, i)) % 2 === 0) return i;
  }
  return -1;
}

export interface Assignment {
  key: string;
  value: string;
  rawValue: string;
  quote: Quote;
  exported: boolean;
  /** Number of extra physical lines the value consumed. */
  extraLines: number;
}

/**
 * Parse the logical line at `lines[index]`, folding any continuation lines that a
 * quoted value spans. Returns null when the line is not an assignment.
 */
function parseAt(lines: string[], index: number, strict: boolean, pathLabel: string): Assignment | null {
  const match = ASSIGN_RE.exec(lines[index] ?? "");
  if (match === null) return null;
  const exported = match[1] !== undefined;
  const key = match[2] ?? "";
  let rest = match[3] ?? "";
  let extraLines = 0;
  let quote: Quote = "none";
  let value = "";
  let rawValue = rest;

  const first = rest.charAt(0);
  if (first === '"' || first === "'") {
    let buffer = rest;
    let closing = findClosingQuote(buffer, first);
    while (closing === -1 && index + 1 < lines.length) {
      buffer += "\n" + lines[index + 1];
      index += 1;
      extraLines += 1;
      closing = findClosingQuote(buffer, first);
    }
    if (closing === -1) {
      if (strict) {
        throw new EnvParseError("unterminated " + first + " quote for key " + key + " in " + pathLabel, index + 1);
      }
      quote = first === '"' ? "double" : "single";
      rawValue = buffer;
      value = quote === "double" ? expandEscapes(buffer.slice(1)) : buffer.slice(1);
    } else {
      quote = first === '"' ? "double" : "single";
      rawValue = buffer.slice(0, closing + 1);
      const inner = buffer.slice(1, closing);
      value = quote === "double" ? expandEscapes(inner) : inner;
    }
  } else {
    const hashAt = findCommentHash(rest);
    const cut = hashAt === -1 ? rest : rest.slice(0, hashAt);
    rawValue = cut.trim();
    value = rawValue.replace(/\\ /g, " ").replace(/\\#/g, "#").replace(/\\\$/g, "$");
  }

  return { key, value, rawValue, quote, exported, extraLines };
}

/** Parse exactly one logical line (no continuation folding). Returns null when it is not an assignment. */
export function parseAssignment(text: string): Assignment | null {
  return parseAt([text], 0, false, "<line>");
}

/** Parse .env text into entries plus duplicate bookkeeping. */
export function parseEnvText(text: string, options: ParseOptions = {}): EnvFile {
  const pathLabel = options.path ?? "<string>";
  const strict = options.strict ?? false;
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const body = stripBom(text);
  const newline = detectNewline(body);
  const lines = body.split(/\r?\n/);

  const entries: EnvEntry[] = [];
  const invalid: InvalidLine[] = [];
  const seen = new Map<string, number[]>();
  let pendingComments: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const lineNumber = index + 1;
    const physical = lines[index] ?? "";
    index += 1;
    const trimmed = physical.trim();
    if (trimmed === "") {
      pendingComments = [];
      continue;
    }
    if (trimmed.startsWith("#")) {
      pendingComments.push(trimmed);
      continue;
    }

    const comments = pendingComments;
    pendingComments = [];
    const assignment = parseAt(lines, index - 1, strict, pathLabel);
    if (assignment === null) {
      // Never store the text: an unparseable line is where secrets hide.
      invalid.push(describeInvalidLine(lineNumber, trimmed));
      continue;
    }
    index += assignment.extraLines;
    const entry: EnvEntry = {
      key: assignment.key,
      value: assignment.value,
      rawValue: assignment.rawValue,
      line: lineNumber,
      quote: assignment.quote,
      exported: assignment.exported,
      comments,
    };
    // A value can only hold the opening line of a PEM block. Everything below it
    // is unparseable as a KEY=value line, so without this it would be filed as
    // "invalid" (noise) and, worse, never compared - which is how a rotated
    // private key used to look like "files are identical".
    //
    // Two shapes have to be recognised, because both occur in the wild:
    //   KEY=-----BEGIN ...-----   (the marker is the value)
    //   KEY=                      (empty value, marker on the next line)
    //   -----BEGIN ...-----
    // The second is what `cat key.pem >> .env` produces, and missing it left the
    // whole block unprotected. A third shape - a PEM block with no KEY above it
    // at all - stays in `invalid`, where the descriptors carry digests only, so
    // it is still comparable and still never printable.
    const bareBegin = assignment.value === "" && opensPemBlock(lines[index] ?? "");
    if (opensPemBlock(assignment.value) || bareBegin) {
      const consumed: string[] = [];
      let cursor = index;
      while (cursor < lines.length) {
        const raw = lines[cursor] ?? "";
        if (!isPemBodyLine(raw)) break;
        consumed.push(raw);
        cursor += 1;
        if (closesPemBlock(raw)) break;
      }
      if (consumed.length > 0) {
        entry.pemBodyDigest = shortDigest(consumed.join("\n"));
        // Count the key material only: the -----BEGIN----- and -----END-----
        // markers are delimiters, not secrets, and a report that says "+4 more
        // lines" for a three-line body is a number users learn to ignore.
        entry.pemLines = consumed.filter((line) => !closesPemBlock(line) && !opensPemBlock(line)).length;
        index = cursor;
      }
    }
    entries.push(entry);
    const at = seen.get(assignment.key);
    if (at === undefined) seen.set(assignment.key, [lineNumber]);
    else at.push(lineNumber);
  }

  if (strict && invalid.length > 0) {
    const first = invalid[0]!;
    throw new EnvParseError(pathLabel + ": line " + first.line + " is not a valid KEY=value assignment", first.line);
  }

  const duplicates: DuplicateKey[] = [];
  for (const [key, at] of seen) {
    if (at.length > 1) duplicates.push({ key, lines: [...at] });
  }
  duplicates.sort((a, b) => (a.lines[0] ?? 0) - (b.lines[0] ?? 0));

  return { path: pathLabel, entries, duplicates, newline, hasBom, invalid };
}

/** Read and parse a .env file from disk. */
export function parseEnvFile(absPath: string, displayPath?: string, strict = false): EnvFile {
  const text = readFileSync(absPath, "utf8");
  return parseEnvText(text, { path: displayPath ?? absPath, strict });
}

/** Last assignment wins, matching dotenv behaviour. */
export function toRecord(file: EnvFile): Map<string, EnvEntry> {
  const map = new Map<string, EnvEntry>();
  for (const entry of file.entries) map.set(entry.key, entry);
  return map;
}

/** Serialise a value back into a .env line using the original quoting style. */
export function formatValue(value: string, quote: Quote): string {
  // An empty value never needs quoting; KEY= is the canonical dotenv spelling.
  if (value === "") return "";
  if (quote === "single") {
    if (!value.includes("'") && !value.includes("\n")) return "'" + value + "'";
    return value;
  }
  if (quote === "double") {
    const escaped = value
      .split("\\").join("\\\\")
      .split('"').join('\\"')
      .split("\n").join("\\n")
      .split("\r").join("\\r");
    return '"' + escaped + '"';
  }
  if (value === "" || /[\s#"'\\]/.test(value)) {
    return '"' + value.split('"').join('\\"') + '"';
  }
  return value;
}

/** True when the key is a legal dotenv identifier. */
export function isValidKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** Render one assignment line. */
export function renderAssignment(key: string, value: string, quote: Quote, exported = false): string {
  return (exported ? "export " : "") + key + "=" + formatValue(value, quote);
}