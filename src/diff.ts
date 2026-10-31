import { parseEnvFile, toRecord } from "./parser.js";
import { maskValue } from "./util.js";
import type { DiffChangedEntry, DiffEntry, DiffReport, EnvEntry } from "./types.js";
import { VERSION } from "./report.js";

export interface DiffOptions {
  /** Show plaintext values instead of masked ones. Masks are the default. */
  reveal?: boolean;
}

/** True when the value opens a PEM block, i.e. the real key material is below it. */
function isPem(entry: EnvEntry): boolean {
  return entry.pemBodyDigest !== undefined;
}

/** The larger of the two body lengths, so the report can say "+ N more lines". */
function pemLinesOf(a: EnvEntry | undefined, b: EnvEntry | undefined): number | undefined {
  const body = Math.max(a?.pemLines ?? 0, b?.pemLines ?? 0);
  return body > 0 ? body : undefined;
}

/** Compare two env files key by key. */
export function diffFiles(aPath: string, bPath: string, displayA: string, displayB: string, options: DiffOptions = {}): DiffReport {
  const fileA = parseEnvFile(aPath, displayA);
  const fileB = parseEnvFile(bPath, displayB);
  const a = toRecord(fileA);
  const b = toRecord(fileB);
  // A PEM header is not a value you can retype: revealing it would hand out the
  // block opener for a key whose body lives on the following lines. Always mask.
  const show = (entry: EnvEntry): string => {
    if (isPem(entry)) return maskValue(entry.value);
    return options.reveal === true ? entry.value : maskValue(entry.value);
  };
  const withPem = <T extends { key: string }>(entry: T, ...sides: (EnvEntry | undefined)[]): T => {
    const body = pemLinesOf(sides[0], sides[1]);
    return body === undefined ? entry : { ...entry, pemLines: body };
  };

  const onlyA: DiffEntry[] = [];
  const onlyB: DiffEntry[] = [];
  const changed: DiffChangedEntry[] = [];
  let same = 0;

  // PEM bodies never fit in a value, so the header alone cannot decide whether a
  // key was rotated - compare the digest of the lines underneath it too.
  const differs = (x: EnvEntry, y: EnvEntry): boolean =>
    x.value !== y.value || x.pemBodyDigest !== y.pemBodyDigest;

  for (const [key, entry] of a) {
    const other = b.get(key);
    if (other === undefined) {
      onlyA.push(withPem({ key, value: show(entry) }, entry, undefined));
      continue;
    }
    if (differs(entry, other)) {
      changed.push(withPem({ key, a: show(entry), b: show(other) }, entry, other));
      continue;
    }
    same += 1;
  }
  for (const [key, entry] of b) {
    if (!a.has(key)) onlyB.push(withPem({ key, value: show(entry) }, undefined, entry));
  }

  const byKey = (x: { key: string }, y: { key: string }): number => x.key.localeCompare(y.key);
  onlyA.sort(byKey);
  onlyB.sort(byKey);
  changed.sort(byKey);

  // Lines that are not a KEY=value assignment are not keys, but they are still
  // content: two files that differ in them are not identical.
  const invalidA = [...fileA.invalid].sort((x, y) => x.line - y.line);
  const invalidB = [...fileB.invalid].sort((x, y) => x.line - y.line);
  const sameInvalid =
    invalidA.length === invalidB.length &&
    invalidA.every((line, index) => line.digest === invalidB[index]?.digest);

  return {
    tool: "envpulse",
    version: VERSION,
    command: "diff",
    a: { path: displayA, keys: a.size },
    b: { path: displayB, keys: b.size },
    onlyA,
    onlyB,
    changed,
    invalidA,
    invalidB,
    same,
    identical:
      onlyA.length === 0 && onlyB.length === 0 && changed.length === 0 && sameInvalid,
  };
}
