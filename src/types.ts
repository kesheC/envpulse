/** Shared type definitions for envpulse. */

export type Severity = "high" | "medium" | "low";

export type Quote = "none" | "single" | "double";

/** One `KEY=value` assignment parsed out of a .env style file. */
export interface EnvEntry {
  key: string;
  /** Value with surrounding quotes removed and escapes expanded. */
  value: string;
  /** Value exactly as written in the file (quotes included, escapes untouched). */
  rawValue: string;
  /** 1-based line number where the assignment starts. */
  line: number;
  quote: Quote;
  /** True when the line was written as `export KEY=value`. */
  exported: boolean;
  /** Comment lines (trimmed, leading `#` kept) directly above the assignment. */
  comments: string[];
}

export interface DuplicateKey {
  key: string;
  /** Every 1-based line number the key is assigned on. */
  lines: number[];
}

export interface EnvFile {
  /** Path relative to the working directory, always with forward slashes. */
  path: string;
  entries: EnvEntry[];
  duplicates: DuplicateKey[];
  newline: "\n" | "\r\n";
  hasBom: boolean;
  /** Lines that are neither blank, comment, nor a valid KEY=value assignment. */
  invalid: { line: number; text: string }[];
}

/** Where a variable was read from in source code. */
export interface EnvVarHit {
  key: string;
  /** Source file path relative to the working directory, forward slashes. */
  file: string;
  line: number;
}

export interface ScanResult {
  filesScanned: number;
  /** key -> every place the code reads it. */
  vars: Map<string, EnvVarHit[]>;
}

export type FindingCode =
  | "MISSING"
  | "UNUSED"
  | "DRIFT"
  | "DUPLICATE"
  | "UNSAFE"
  | "EMPTY";

export interface Finding {
  code: FindingCode;
  severity: Severity;
  key: string;
  /** One-line human readable explanation. */
  message: string;
  /** File the finding is anchored to, when it is about one file. */
  file?: string;
  /** Line number inside `file`. */
  line?: number;
  /** All files involved (DRIFT lists where the key lives). */
  files?: string[];
  /** Source locations, for MISSING / UNUSED. */
  hits?: EnvVarHit[];
  /** Rule id for UNSAFE findings. */
  rule?: string;
}

export interface CheckEnvFileInfo {
  path: string;
  kind: "example" | "env";
  keys: number;
  duplicates: string[];
}

export interface CheckCounts {
  high: number;
  medium: number;
  low: number;
}

export interface CheckReport {
  tool: "envpulse";
  version: string;
  command: "check";
  cwd: string;
  envFiles: CheckEnvFileInfo[];
  sourceFiles: number;
  variablesRead: string[];
  findings: Finding[];
  counts: CheckCounts;
  notes: string[];
  exitCode: number;
}

export interface DiffEntry {
  key: string;
  value: string;
}

export interface DiffReport {
  tool: "envpulse";
  version: string;
  command: "diff";
  a: { path: string; keys: number };
  b: { path: string; keys: number };
  onlyA: DiffEntry[];
  onlyB: DiffEntry[];
  changed: { key: string; a: string; b: string }[];
  same: number;
  identical: boolean;
}