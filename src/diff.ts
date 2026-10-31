import { readFileSync } from "node:fs";
import { parseEnvFile, toRecord } from "./parser.js";
import { closesPemBlock, isPemBodyLine, opensPemBlock } from "./rules.js";
import { maskValue } from "./util.js";
import type { DiffChangedEntry, DiffEntry, DiffReport } from "./types.js";
import { VERSION } from "./report.js";

export interface DiffOptions {
  /** Show plaintext values instead of masked ones. Masks are the default. */
  reveal?: boolean;
}

/**
 * Count the raw PEM body lines that follow a `KEY=-----BEGIN ...` header in
 * either file. A .env cannot hold a PEM in one value, so the key's value in the
 * report is just the header - the caller says so instead of pretending the
 * value ended there.
 */
function countPemBodies(aPath: string, bPath: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [filePath, displayPath] of [
    [aPath, "a"],
    [bPath, "b"],
  ] as const) {
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const file = parseEnvFile(filePath, displayPath);
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    for (const entry of file.entries) {
      if (!opensPemBlock(entry.value)) continue;
      let body = 0;
      for (let index = entry.line; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || !isPemBodyLine(line)) break;
        body += 1;
        if (closesPemBlock(line)) break;
      }
      counts.set(entry.key, Math.max(counts.get(entry.key) ?? 0, body));
    }
  }
  return counts;
}

/** Compare two env files key by key. */
export function diffFiles(aPath: string, bPath: string, displayA: string, displayB: string, options: DiffOptions = {}): DiffReport {
  const a = toRecord(parseEnvFile(aPath, displayA));
  const b = toRecord(parseEnvFile(bPath, displayB));
  // A PEM header is not a value you can retype: revealing it would hand out the
  // block opener for a key whose body lives on the following lines. Always mask.
  const pemBody = countPemBodies(aPath, bPath);
  const show = (key: string, value: string): string => {
    if (pemBody.has(key)) return maskValue(value);
    return options.reveal === true ? value : maskValue(value);
  };
  const withPem = <T extends { key: string }>(entry: T): T => {
    const body = pemBody.get(entry.key);
    return body === undefined ? entry : { ...entry, pemLines: body };
  };

  const onlyA: DiffEntry[] = [];
  const onlyB: DiffEntry[] = [];
  const changed: DiffChangedEntry[] = [];
  let same = 0;

  for (const [key, entry] of a) {
    const other = b.get(key);
    if (other === undefined) {
      onlyA.push(withPem({ key, value: show(key, entry.value) }));
      continue;
    }
    if (other.value !== entry.value) {
      changed.push(withPem({ key, a: show(key, entry.value), b: show(key, other.value) }));
      continue;
    }
    same += 1;
  }
  for (const [key, entry] of b) {
    if (!a.has(key)) onlyB.push(withPem({ key, value: show(key, entry.value) }));
  }

  const byKey = (x: { key: string }, y: { key: string }): number => x.key.localeCompare(y.key);
  onlyA.sort(byKey);
  onlyB.sort(byKey);
  changed.sort(byKey);

  return {
    tool: "envpulse",
    version: VERSION,
    command: "diff",
    a: { path: displayA, keys: a.size },
    b: { path: displayB, keys: b.size },
    onlyA,
    onlyB,
    changed,
    same,
    identical: onlyA.length === 0 && onlyB.length === 0 && changed.length === 0,
  };
}
