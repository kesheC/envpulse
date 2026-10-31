import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { InvalidLine } from "./types.js";

/** Convert a platform path to forward slashes so output is identical on Windows and POSIX. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Shannon entropy (bits per character) of a string. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Short, stable fingerprint of a piece of text.
 *
 * Used to compare things that must never be printed: a PEM body lives in the
 * file but not in any env value, so the only way diff can notice a rotated key
 * is by comparing a digest.
 */
export function shortDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Does this line look like key material rather than a typo?
 *
 * Used only to pick the right wording for an unparseable line. The line itself
 * is never printed either way - that is the whole point of tracking it as a
 * length plus a digest.
 */
export function looksLikeKeyMaterial(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (/-{5}\s*(BEGIN|END)\s/i.test(trimmed)) return true;
  // A base64 run: the shape every PEM body line takes.
  return trimmed.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
}

/**
 * Describe a line the parser could not turn into an assignment, without
 * carrying its text.
 *
 * `diff` used to print these lines verbatim, which put raw PEM body lines and
 * `DATABASE_URL postgres://user:pass@host` on stdout. `check` already refused to
 * print them; now the data structure makes printing them impossible.
 */
export function describeInvalidLine(line: number, text: string): InvalidLine {
  const trimmed = text.trim();
  return {
    line,
    length: trimmed.length,
    keyMaterial: looksLikeKeyMaterial(trimmed),
    digest: shortDigest(trimmed),
  };
}

/** Mask a secret so it is still recognisable but not copyable. */
export function maskValue(value: string): string {
  if (value === "") return "";
  if (value.length <= 8) return "****";
  return value.slice(0, 2) + "****" + value.slice(-2);
}

/**
 * Every path git tracks in `cwd`, normalised to forward slashes.
 *
 * Returns null when git cannot answer (no git binary, not a repository,
 * dubious ownership). None of those are errors for envpulse: the caller just
 * falls back to the rules that do not need git.
 */
export function gitTrackedFiles(cwd: string): Set<string> | null {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  let result;
  try {
    result = spawnSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
      cwd,
      env,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (result.error !== undefined && result.error !== null) return null;
  if (result.status !== 0) return null;
  const tracked = new Set<string>();
  for (const entry of String(result.stdout ?? "").split("\0")) {
    if (entry !== "") tracked.add(entry);
  }
  return tracked;
}

/** Directories that never contain application source or env files. */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".github",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "venv",
  ".venv",
  "site-packages",
  "target",
  "vendor",
  "bower_components",
  ".idea",
  ".vscode",
]);

export interface WalkEntry {
  /** Path relative to the walk root, forward slashes. */
  rel: string;
  abs: string;
  size: number;
}

export interface WalkOptions {
  skipDirs?: ReadonlySet<string>;
  maxDepth?: number;
  maxFiles?: number;
  /** Skip files larger than this many bytes. */
  sizeLimit?: number;
}

/**
 * Deterministically walk a directory tree, sorted by name so that repeated runs
 * over the same tree produce byte identical output.
 */
export function walkTree(root: string, options: WalkOptions = {}): WalkEntry[] {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxDepth = options.maxDepth ?? 12;
  const maxFiles = options.maxFiles ?? 20000;
  const sizeLimit = options.sizeLimit ?? 1024 * 1024;
  const results: WalkEntry[] = [];

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || results.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        visit(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size > sizeLimit) continue;
      const rel = toPosix(path.relative(root, abs));
      results.push({ rel, abs, size });
    }
  };

  visit(root, 0);
  return results;
}

/** Read a text file, returning null when it cannot be read. */
export function readTextFile(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** Env file names we recognise: .env, .env.local, prod.env, prod.env.local ... */
export function isEnvFileName(base: string): boolean {
  if (/^\.env(\.[A-Za-z0-9_.-]+)*$/.test(base)) return true;
  if (/\.env$/i.test(base)) return true;
  if (/\.env\.[A-Za-z0-9_-]+$/i.test(base)) return true;
  return false;
}

/** Example / sample files are the ones that get committed. */
export function isExampleEnvFileName(base: string): boolean {
  return /(^|\.)(example|sample|template|dist|tpl|defaults)$/i.test(base);
}

/** Build a line-number lookup from a text buffer. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number for a character offset. */
export function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
