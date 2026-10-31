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
  /**
   * Digest of the raw lines that follow a `KEY=-----BEGIN ...` header, when the
   * value opens a PEM block. The body never fits in a value, so this is what
   * makes two keys comparable - and it is a digest so it is safe to print.
   */
  pemBodyDigest?: string;
  /**
   * How many lines of actual key material the PEM block held. The closing
   * `-----END ...-----` marker is not counted: it carries no secret, and
   * quoting it in "+N more lines" made the report overstate the block by one.
   */
  pemLines?: number;
}

export interface DuplicateKey {
  key: string;
  /** Every 1-based line number the key is assigned on. */
  lines: number[];
}

/**
 * A line that is neither blank, comment, nor a valid `KEY=value` assignment.
 *
 * The raw text is deliberately absent. An unparseable line is exactly the kind
 * of content a secret ends up on - a PEM body the parser did not attribute to a
 * key, a `DATABASE_URL postgres://user:pass@host` with the `=` missing - so
 * printing it would leak what this tool exists to contain. A one-way digest
 * keeps the line comparable without exposing it.
 */
export interface InvalidLine {
  /** 1-based line number. */
  line: number;
  /** Length of the trimmed line, so a report can still say how big it was. */
  length: number;
  /** True when the line looks like key material rather than a mistake. */
  keyMaterial: boolean;
  /** SHA-256 prefix of the trimmed line; comparable, not reversible. */
  digest: string;
}

export interface EnvFile {
  /** Path relative to the working directory, always with forward slashes. */
  path: string;
  entries: EnvEntry[];
  duplicates: DuplicateKey[];
  newline: "\n" | "\r\n";
  hasBom: boolean;
  /** Lines that are neither blank, comment, nor a valid KEY=value assignment. */
  invalid: InvalidLine[];
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
  | "EMPTY"
  | "INVALID";

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
  /** Set when the value is only the header of a multi-line PEM block. */
  pemLines?: number;
}

export interface DiffChangedEntry {
  key: string;
  a: string;
  b: string;
  /** Set when a value is only the header of a multi-line PEM block. */
  pemLines?: number;
}

export interface DiffReport {
  tool: "envpulse";
  version: string;
  command: "diff";
  a: { path: string; keys: number };
  b: { path: string; keys: number };
  onlyA: DiffEntry[];
  onlyB: DiffEntry[];
  changed: DiffChangedEntry[];
  /** Lines that are not a KEY=value assignment, per side. */
  invalidA: InvalidLine[];
  invalidB: InvalidLine[];
  same: number;
  identical: boolean;
}