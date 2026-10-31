import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatValue, parseEnvFile, parseEnvText, renderAssignment, toRecord } from "./parser.js";
import { closesPemBlock, isPemBodyLine, isSensitiveValue, opensPemBlock } from "./rules.js";
import { scanSource } from "./scan.js";
import type { EnvEntry } from "./types.js";
import { maskValue, toPosix } from "./util.js";

export interface SyncOptions {
  /** Template file to read keys from. */
  from: string;
  /** File to bring up to date. */
  to: string;
  /** Compute the result without touching the disk. */
  dryRun?: boolean;
  /** Display path used in messages (defaults to `to`). */
  displayName?: string;
}

export interface SyncChange {
  key: string;
  /** 1-based line in the ORIGINAL target file where the key will be inserted. */
  beforeLine: number;
  comments: string[];
  text: string;
}

export interface SyncResult {
  from: string;
  to: string;
  dryRun: boolean;
  /** Keys that already existed in the target. */
  alreadyPresent: number;
  /** Keys that existed in the target but are gone from the template — reported, never removed. */
  staleKeys: string[];
  changes: SyncChange[];
  added: number;
  /** The full new file content (also useful for tests and dry-run previews). */
  output: string;
  /** True when the file on disk was written. */
  written: boolean;
}

/**
 * Add every key of `from` that is absent from `to`, keeping the target's
 * existing lines byte for byte. Each inserted key is anchored right before the
 * next template key that already exists in the target, so the file keeps the
 * template's ordering; keys with no such anchor are appended at the end.
 */
export function syncEnvFiles(options: SyncOptions): SyncResult {
  const fromText = readFileSync(options.from, "utf8");
  const toText = readTarget(options.to);
  const template = parseEnvText(fromText, { path: toPosix(options.from) });
  const target = parseEnvText(toText, { path: toPosix(options.to) });
  const targetMap = toRecord(target);

  const newline = target.newline;
  const raw = toText.replace(/^\uFEFF/, "");
  const endsWithNewline = /\r?\n$/.test(raw);
  const lines = raw === "" ? [] : raw.split(/\r?\n/).slice(0, endsWithNewline ? -1 : undefined);

  const templateEntries = dedupeTemplate(template.entries);
  const present = new Set(targetMap.keys());
  const missing = templateEntries.filter((entry) => !present.has(entry.key));
  const staleKeys = [...present].filter((key) => !templateEntries.some((t) => t.key === key)).sort((a, b) => a.localeCompare(b));

  // Line index (0-based) where each present key is first assigned.
  const firstLine = new Map<string, number>();
  for (const entry of target.entries) {
    if (!firstLine.has(entry.key)) firstLine.set(entry.key, entry.line - 1);
  }

  const buckets = new Map<number, SyncChange[]>();
  const templateIndex = new Map<string, number>();
  templateEntries.forEach((entry, index) => templateIndex.set(entry.key, index));

  for (const entry of missing) {
    let anchor = lines.length;
    const start = (templateIndex.get(entry.key) ?? 0) + 1;
    for (let i = start; i < templateEntries.length; i++) {
      const candidate = templateEntries[i]!.key;
      const at = firstLine.get(candidate);
      if (at !== undefined) {
        anchor = at;
        break;
      }
    }
    const change: SyncChange = {
      key: entry.key,
      beforeLine: anchor + 1,
      comments: entry.comments,
      text: renderAssignment(entry.key, entry.value, entry.quote, entry.exported),
    };
    const bucket = buckets.get(anchor);
    if (bucket === undefined) buckets.set(anchor, [change]);
    else bucket.push(change);
  }

  const out: string[] = [];
  const anchors = [...buckets.keys()].sort((a, b) => a - b);
  let cursor = 0;
  for (const anchor of anchors) {
    while (cursor < anchor && cursor < lines.length) {
      out.push(lines[cursor] ?? "");
      cursor += 1;
    }
    for (const change of buckets.get(anchor) ?? []) {
      for (const comment of change.comments) out.push(comment);
      out.push(change.text);
    }
  }
  while (cursor < lines.length) {
    out.push(lines[cursor] ?? "");
    cursor += 1;
  }

  let output = out.join(newline);
  // A brand-new file always ends with a newline; an existing one keeps its habit.
  const keepNewline = raw === "" ? out.length > 0 : endsWithNewline;
  if (keepNewline && out.length > 0) output += newline;
  if (target.hasBom) output = "\uFEFF" + output;

  const changes: SyncChange[] = [];
  for (const anchor of anchors) changes.push(...(buckets.get(anchor) ?? []));

  if (options.dryRun !== true && changes.length > 0) {
    writeFileSync(options.to, output, "utf8");
  }

  return {
    from: options.from,
    to: options.to,
    dryRun: options.dryRun === true,
    alreadyPresent: present.size - staleKeys.length,
    staleKeys,
    changes,
    added: changes.length,
    output,
    written: options.dryRun !== true && changes.length > 0,
  };
}

/** Read the target file, treating a missing file as empty so `sync` can create it. */
function readTarget(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Later definitions win, so keep the last entry for each key while preserving order. */
function dedupeTemplate(entries: EnvEntry[]): EnvEntry[] {
  const last = new Map<string, number>();
  entries.forEach((entry, index) => last.set(entry.key, index));
  return entries.filter((entry, index) => last.get(entry.key) === index);
}

export interface MaskOptions {
  /** Mask every value, not just the sensitive ones. */
  all?: boolean;
  /** Mask values whose key name looks secret even when the value looks dull. */
  byKeyName?: boolean;
}

/** Mask sensitive values in raw .env text, preserving layout and comments. */
export function maskText(text: string, options: MaskOptions = {}): string {
  const file = parseEnvText(text, { strict: false });
  const newline = file.newline;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const byLine = new Map<number, EnvEntry>();
  for (const entry of file.entries) {
    if (!byLine.has(entry.line)) byLine.set(entry.line, entry);
  }
  for (const [lineNumber, entry] of byLine) {
    const index = lineNumber - 1;
    const original = lines[index];
    if (original === undefined) continue;
    const sensitive = options.all === true || isSensitiveValue(entry.key, entry.value, { byKeyName: options.byKeyName });
    if (!sensitive) continue;
    const masked = maskValue(entry.value);
    const eq = original.indexOf("=");
    if (eq === -1) continue;
    const prefix = original.slice(0, eq + 1);
    lines[index] = prefix + (entry.quote === "none" ? masked : formatValue(masked, entry.quote));
    // The value alone decides this: a PEM body is a secret no matter what the
    // key is called, so --all and byKeyName must not change the outcome.
    if (opensPemBlock(entry.value)) maskPemBody(lines, index + 1);
  }
  const joined = lines.join(newline);
  return file.hasBom ? "\uFEFF" + joined : joined;
}

/**
 * Mask the raw lines of a PEM block that a single `.env` assignment cannot hold.
 *
 * Everything from `start` up to and including the `-----END ...-----` line is
 * replaced wholesale: the base64 body carries as much secret as the header, and
 * leaving either readable defeats the point of masking.
 */
function maskPemBody(lines: string[], start: number): void {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) return;
    if (!isPemBodyLine(line)) return;
    const closes = closesPemBlock(line);
    lines[index] = maskValue(line.trim());
    if (closes) return;
  }
}

export interface InitOptions {
  /** Directory to scan. */
  cwd: string;
  /** Output file path (relative to cwd). */
  out?: string;
  /** Overwrite an existing output file. */
  force?: boolean;
  /** Do not touch the disk; return the skeleton instead. */
  dryRun?: boolean;
}

export interface InitResult {
  out: string;
  keys: string[];
  written: boolean;
  content: string;
}

/** Generate a .env.example skeleton from the variables the source code reads. */
export function initFromCode(options: InitOptions): InitResult {
  const cwd = path.resolve(options.cwd);
  const scan = scanSource(cwd);
  const keys = [...scan.vars.keys()].sort((a, b) => a.localeCompare(b));

  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const hits = scan.vars.get(key) ?? [];
    const dirs = [...new Set(hits.map((hit) => path.posix.dirname(hit.file)).map((dir) => (dir === "." ? "(root)" : dir)))].sort();
    const group = dirs[0] ?? "(root)";
    const list = groups.get(group);
    if (list === undefined) groups.set(group, [key]);
    else list.push(key);
  }

  const lines: string[] = [];
  lines.push("# Generated by envpulse init --from-code");
  lines.push("# Every key below is read somewhere in this repository.");
  lines.push("# Fill in a real value, or leave it blank to make it optional.");
  lines.push("");
  for (const group of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push("# --- " + group + " ---");
    for (const key of groups.get(group) ?? []) {
      lines.push(key + "=");
    }
    lines.push("");
  }
  const content = lines.join("\n").replace(/\n+$/, "\n");

  const outAbs = path.resolve(cwd, options.out ?? ".env.example");
  let written = false;
  if (options.dryRun !== true) {
    writeFileSync(outAbs, content, { encoding: "utf8", flag: options.force === true ? "w" : "wx" });
    written = true;
  }

  return { out: toPosix(path.relative(cwd, outAbs)) || path.basename(outAbs), keys, written, content };
}