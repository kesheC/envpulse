import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { EnvVarHit, ScanResult } from "./types.js";
import { walkTree, type WalkOptions } from "./util.js";

export type SourceKind = "js" | "py" | "sh" | "unknown";

const JS_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]);
const PY_EXT = new Set([".py", ".pyi"]);
const SH_EXT = new Set([".sh", ".bash", ".zsh", ".ksh"]);

/** Map a file extension to the scanner that understands it. */
export function sourceKind(file: string): SourceKind {
  const ext = extname(file).toLowerCase();
  if (JS_EXT.has(ext)) return "js";
  if (PY_EXT.has(ext)) return "py";
  if (SH_EXT.has(ext)) return "sh";
  return "unknown";
}

const ENV_NAME = "([A-Za-z_][A-Za-z0-9_]*)";

/** Every pattern envpulse treats as "the code reads this environment variable". */
export const READ_PATTERNS: Record<Exclude<SourceKind, "unknown">, RegExp[]> = {
  js: [
    // process.env.FOO  /  process.env["FOO"]  /  process.env?.FOO
    new RegExp("process\\.env\\??\\s*(?:\\.\\s*" + ENV_NAME + "|\\[\\s*[\"'`](" + ENV_NAME + ")[\"'`]\\s*\\])", "g"),
    // import.meta.env.FOO
    new RegExp("import\\.meta\\.env\\??\\s*(?:\\.\\s*" + ENV_NAME + "|\\[\\s*[\"'`](" + ENV_NAME + ")[\"'`]\\s*\\])", "g"),
    // Deno.env.get("FOO")
    new RegExp("Deno\\.env\\.get\\(\\s*[\"'`](" + ENV_NAME + ")[\"'`]", "g"),
  ],
  py: [
    // os.environ["FOO"] / os.environ.get("FOO") / os.getenv("FOO")
    new RegExp("os\\.environ\\[\\s*[\"'](" + ENV_NAME + ")[\"']\\s*\\]", "g"),
    new RegExp("os\\.environ\\.get\\(\\s*[\"'](" + ENV_NAME + ")[\"']", "g"),
    new RegExp("os\\.getenv\\(\\s*[\"'](" + ENV_NAME + ")[\"']", "g"),
  ],
  sh: [
    // $FOO / ${FOO} / ${FOO:-default}
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-=?+][^}]*)?\}/g,
    /(?<![\\$])\$([A-Za-z_][A-Za-z0-9_]*)/g,
  ],
};

/** Shell variables that are shell builtins, not application configuration. */
const SHELL_BUILTINS = new Set([
  "PATH", "HOME", "PWD", "OLDPWD", "SHELL", "USER", "LOGNAME", "UID", "EUID", "GID",
  "RANDOM", "SECONDS", "LINENO", "BASH_SOURCE", "BASH_VERSION", "FUNCNAME", "REPLY",
  "IFS", "PS1", "PS2", "PS3", "PS4", "HOSTNAME", "LANG", "LC_ALL", "TMPDIR", "TERM",
  "?", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "#", "@", "*", "!", "$",
]);

/** Collect the variable names a single source file references. */
export function extractEnvKeys(text: string, kind: SourceKind): string[] {
  if (kind === "unknown") return [];
  const keys: string[] = [];
  for (const pattern of READ_PATTERNS[kind]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      for (let i = 1; i < match.length; i++) {
        const candidate = match[i];
        if (candidate === undefined) continue;
        if (kind === "sh" && SHELL_BUILTINS.has(candidate)) continue;
        keys.push(candidate);
        break;
      }
    }
  }
  return keys;
}

/** 1-based line numbers for every occurrence of a variable read. */
export function locateEnvKeys(text: string, kind: SourceKind, wanted: Set<string>): Map<string, number[]> {
  const found = new Map<string, number[]>();
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  if (kind === "unknown") return found;
  for (const pattern of READ_PATTERNS[kind]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const key = match[1] ?? match[2];
      if (key === undefined || !wanted.has(key)) continue;
      if (kind === "sh" && SHELL_BUILTINS.has(key)) continue;
      let lo = 0;
      let hi = starts.length - 1;
      const offset = match.index;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] ?? 0) <= offset) lo = mid;
        else hi = mid - 1;
      }
      const lines = found.get(key);
      if (lines === undefined) found.set(key, [lo + 1]);
      else if (!lines.includes(lo + 1)) lines.push(lo + 1);
    }
  }
  return found;
}

export interface ScanOptions extends WalkOptions {
  /** Extra file extensions to treat as source, e.g. ".vue" for a project that wants it. */
  extraExtensions?: string[];
}

/**
 * Walk a directory tree and collect every environment variable the source reads.
 * Files that cannot be decoded as UTF-8 text are skipped rather than failing the scan.
 */
export function scanSource(root: string, options: ScanOptions = {}): ScanResult {
  const entries = walkTree(root, options);
  const vars = new Map<string, EnvVarHit[]>();
  let filesScanned = 0;

  for (const entry of entries) {
    const kind = sourceKind(entry.rel);
    if (kind === "unknown") continue;
    let text: string;
    try {
      text = readFileSync(entry.abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    filesScanned += 1;
    const keys = extractEnvKeys(text, kind);
    if (keys.length === 0) continue;
    const wanted = new Set(keys);
    const lines = locateEnvKeys(text, kind, wanted);
    for (const key of wanted) {
      const at = vars.get(key) ?? [];
      const hitLines = lines.get(key) ?? [];
      if (hitLines.length === 0) hitLines.push(1);
      for (const line of hitLines) at.push({ key, file: entry.rel, line });
      vars.set(key, at);
    }
  }

  return { filesScanned, vars };
}