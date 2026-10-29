import { parseEnvFile, toRecord } from "./parser.js";
import { maskValue } from "./util.js";
import type { DiffEntry, DiffReport } from "./types.js";
import { VERSION } from "./report.js";

export interface DiffOptions {
  /** Show plaintext values instead of masked ones. Masks are the default. */
  reveal?: boolean;
}

/** Compare two env files key by key. */
export function diffFiles(aPath: string, bPath: string, displayA: string, displayB: string, options: DiffOptions = {}): DiffReport {
  const a = toRecord(parseEnvFile(aPath, displayA));
  const b = toRecord(parseEnvFile(bPath, displayB));
  const show = (value: string): string => (options.reveal === true ? value : maskValue(value));

  const onlyA: DiffEntry[] = [];
  const onlyB: DiffEntry[] = [];
  const changed: { key: string; a: string; b: string }[] = [];
  let same = 0;

  for (const [key, entry] of a) {
    const other = b.get(key);
    if (other === undefined) {
      onlyA.push({ key, value: show(entry.value) });
      continue;
    }
    if (other.value !== entry.value) {
      changed.push({ key, a: show(entry.value), b: show(other.value) });
      continue;
    }
    same += 1;
  }
  for (const [key, entry] of b) {
    if (!a.has(key)) onlyB.push({ key, value: show(entry.value) });
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
