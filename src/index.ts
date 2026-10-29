/**
 * envpulse library API.
 *
 * This module never reads process.argv and never calls process.exit - use
 * `src/cli.ts` for that. Everything exported here is pure enough to test.
 */

export type {
  CheckCounts,
  CheckEnvFileInfo,
  CheckReport,
  DiffEntry,
  DiffReport,
  DuplicateKey,
  EnvEntry,
  EnvFile,
  EnvVarHit,
  Finding,
  FindingCode,
  Quote,
  ScanResult,
  Severity,
} from "./types.js";

export {
  EnvParseError,
  detectNewline,
  expandEscapes,
  findCommentHash,
  formatValue,
  isValidKey,
  parseAssignment,
  parseEnvFile,
  parseEnvText,
  renderAssignment,
  stripBom,
  toRecord,
} from "./parser.js";

export {
  READ_PATTERNS,
  extractEnvKeys,
  locateEnvKeys,
  scanSource,
  sourceKind,
} from "./scan.js";
export type { ScanOptions, SourceKind } from "./scan.js";

export {
  UNSAFE_RULES,
  isHighEntropySecret,
  isPlaceholder,
  isSensitiveValue,
  matchUnsafe,
} from "./rules.js";
export type { SensitiveKeyOptions, UnsafeRule } from "./rules.js";

export {
  checkProject,
  compareFindings,
  countFindings,
  discoverEnvFiles,
  emptyCounts,
  pickTemplate,
} from "./checker.js";
export type { CheckOptions } from "./checker.js";

export { diffFiles } from "./diff.js";
export type { DiffOptions } from "./diff.js";

export { initFromCode, maskText, syncEnvFiles } from "./fix.js";
export type { InitOptions, InitResult, MaskOptions, SyncChange, SyncOptions, SyncResult } from "./fix.js";

export {
  SEVERITY_ORDER,
  VERSION,
  formatCheckReport,
  formatDiffReport,
  groupFindings,
} from "./report.js";
export type { FormatOptions } from "./report.js";