import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseEnvText } from "./parser.js";
import { matchUnsafe } from "./rules.js";
import { scanSource } from "./scan.js";
import type {
  CheckCounts,
  CheckEnvFileInfo,
  CheckReport,
  Finding,
  FindingCode,
  Severity,
} from "./types.js";
import { isEnvFileName, isExampleEnvFileName, readTextFile, toPosix, walkTree } from "./util.js";
import { VERSION } from "./report.js";

export interface CheckOptions {
  /** Directory to inspect. */
  cwd: string;
  /** Env file to treat as the template; defaults to the first example file found. */
  template?: string;
  /** Skip the UNSAFE rules. */
  noUnsafe?: boolean;
  /** Skip the UNUSED rule. */
  noUnused?: boolean;
  /** Extra env files to include, relative to cwd. */
  extraEnvFiles?: string[];
  /** Disable ANSI colour in the rendered report (does not affect this function). */
  color?: boolean;
}

/** Env files always considered even when a repo would not surface them in git. */
const ALWAYS_SCAN = [".env", ".env.local", ".env.example", ".env.sample", ".env.template", ".env.dist"];

/** Natural rank so the example file wins over a real .env when guessing the template. */
function templateRank(base: string): number {
  if (isExampleEnvFileName(base)) return 0;
  if (base === ".env") return 2;
  return 1;
}

/** Collect every env file in the tree, sorted and de-duplicated. */
export function discoverEnvFiles(cwd: string, extra: string[] = []): string[] {
  const found = new Set<string>();
  const rootEntries = (() => {
    try {
      return readdirSync(cwd);
    } catch {
      return [] as string[];
    }
  })();
  for (const name of rootEntries) {
    if (!isEnvFileName(name)) continue;
    try {
      if (statSync(path.join(cwd, name)).isFile()) found.add(name);
    } catch {
      /* ignore */
    }
  }
  for (const name of ALWAYS_SCAN) {
    try {
      if (statSync(path.join(cwd, name)).isFile()) found.add(name);
    } catch {
      /* ignore */
    }
  }
  for (const entry of walkTree(cwd, { maxDepth: 4 })) {
    const base = entry.rel.split("/").pop() ?? entry.rel;
    if (entry.rel.includes("/") && isEnvFileName(base)) found.add(entry.rel);
  }
  for (const name of extra) {
    if (name !== "") found.add(toPosix(name));
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/** Pick the template env file: explicit wins, else the best example file, else .env. */
export function pickTemplate(files: string[], explicit?: string): string | undefined {
  if (explicit !== undefined) return files.find((f) => f === explicit) ?? explicit;
  const ranked = [...files].sort((a, b) => {
    const ra = templateRank(a.split("/").pop() ?? a);
    const rb = templateRank(b.split("/").pop() ?? b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
  return ranked[0];
}

function severityFor(code: FindingCode, extra?: string): Severity {
  switch (code) {
    case "UNSAFE":
      return extra === "high-entropy" ? "high" : "high";
    case "DUPLICATE":
      return "medium";
    case "MISSING":
      return "high";
    case "DRIFT":
      return "medium";
    case "EMPTY":
      return "low";
    case "UNUSED":
      return "low";
    default:
      return "low";
  }
}

export function emptyCounts(): CheckCounts {
  return { high: 0, medium: 0, low: 0 };
}

export function countFindings(findings: Finding[]): CheckCounts {
  const counts = emptyCounts();
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** Run the full consistency + leak check. Never throws for expected bad input. */
export function checkProject(options: CheckOptions): CheckReport {
  const cwd = path.resolve(options.cwd);
  const notes: string[] = [];
  const envFiles = discoverEnvFiles(cwd, options.extraEnvFiles ?? []);

  const parsed: { file: string; base: string; text: string; keys: string[]; example: boolean; duplicates: string[] }[] = [];
  const envInfos: CheckEnvFileInfo[] = [];

  for (const rel of envFiles) {
    const abs = path.join(cwd, ...rel.split("/"));
    const text = readTextFile(abs);
    if (text === null) continue;
    const base = rel.split("/").pop() ?? rel;
    const parsedFile = parseEnvText(text, { path: rel, strict: false });
    const keys = [...new Set(parsedFile.entries.map((e) => e.key))].sort((a, b) => a.localeCompare(b));
    const example = isExampleEnvFileName(base);
    parsed.push({ file: rel, base, text, keys, example, duplicates: parsedFile.duplicates.map((d) => d.key) });
    envInfos.push({ path: rel, kind: example ? "example" : "env", keys: keys.length, duplicates: parsedFile.duplicates.map((d) => d.key) });
  }

  const templateRel = pickTemplate(parsed.map((p) => p.file), options.template);
  const template = parsed.find((p) => p.file === templateRel);
  if (template !== undefined && !template.example) {
    notes.push(`note: template ${template.file} is not an example file - it may contain real values.`);
  }

  const scan = scanSource(cwd);
  const variablesRead = [...scan.vars.keys()].sort((a, b) => a.localeCompare(b));

  const findings: Finding[] = [];

  // ---- MISSING: read by code but absent from the template -------------------
  if (template !== undefined) {
    const templateKeys = new Set(template.keys);
    for (const key of variablesRead) {
      if (templateKeys.has(key)) continue;
      const hits = scan.vars.get(key) ?? [];
      findings.push({
        code: "MISSING",
        severity: severityFor("MISSING"),
        key,
        message: `read by code but missing from ${template.file}`,
        file: template.file,
        hits,
      });
    }
  } else if (variablesRead.length > 0) {
    notes.push("note: no template env file found, so MISSING cannot be reported. Create .env.example (try `envpulse init --from-code`).");
  }

  // ---- UNUSED: in the template but never read -------------------------------
  if (template !== undefined && options.noUnused !== true) {
    for (const key of template.keys) {
      if (scan.vars.has(key)) continue;
      findings.push({
        code: "UNUSED",
        severity: severityFor("UNUSED"),
        key,
        message: `declared in ${template.file} but never read by scanned source`,
        file: template.file,
      });
    }
  }

  // ---- DRIFT: key sets differ between env files -----------------------------
  if (parsed.length > 1) {
    const union = new Set<string>();
    for (const p of parsed) for (const key of p.keys) union.add(key);
    for (const key of [...union].sort((a, b) => a.localeCompare(b))) {
      const missingFrom = parsed.filter((p) => !p.keys.includes(key));
      const presentIn = parsed.filter((p) => p.keys.includes(key));
      if (missingFrom.length === 0 || presentIn.length === 0) continue;
      findings.push({
        code: "DRIFT",
        severity: severityFor("DRIFT"),
        key,
        message: `present in ${presentIn.map((p) => p.base).join(", ")} but not in ${missingFrom.map((p) => p.base).join(", ")}`,
        files: [...presentIn.map((p) => p.file), ...missingFrom.map((p) => p.file)],
      });
    }
  }

  // ---- DUPLICATE + EMPTY + UNSAFE per file ---------------------------------
  for (const p of parsed) {
    const file = parseEnvText(p.text, { path: p.file, strict: false });
    for (const dup of file.duplicates) {
      findings.push({
        code: "DUPLICATE",
        severity: severityFor("DUPLICATE"),
        key: dup.key,
        message: `defined ${dup.lines.length} times (lines ${dup.lines.join(", ")}) - the last one wins`,
        file: p.file,
        line: dup.lines[0],
      });
    }
    const seenEmpty = new Set<string>();
    for (const entry of file.entries) {
      if (entry.value.trim() === "" && !seenEmpty.has(entry.key)) {
        seenEmpty.add(entry.key);
        findings.push({
          code: "EMPTY",
          severity: severityFor("EMPTY"),
          key: entry.key,
          message: "declared but has no value",
          file: p.file,
          line: entry.line,
        });
      }
      if (options.noUnsafe === true || !p.example) continue;
      const rule = matchUnsafe(entry.value);
      if (rule === null) continue;
      findings.push({
        code: "UNSAFE",
        severity: severityFor("UNSAFE", rule.id),
        key: entry.key,
        message: `looks like a real secret (${rule.description}) committed in a template file`,
        file: p.file,
        line: entry.line,
        rule: rule.id,
      });
    }
  }

  findings.sort(compareFindings);
  const counts = countFindings(findings);
  const exitCode = counts.high > 0 ? 1 : 0;

  return {
    tool: "envpulse",
    version: VERSION,
    command: "check",
    cwd,
    envFiles: envInfos.sort((a, b) => a.path.localeCompare(b.path)),
    sourceFiles: scan.filesScanned,
    variablesRead,
    findings,
    counts,
    notes,
    exitCode,
  };
}

const CODE_ORDER: FindingCode[] = ["UNSAFE", "MISSING", "DRIFT", "DUPLICATE", "EMPTY", "UNUSED"];
const SEVERITY_INDEX: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function compareFindings(a: Finding, b: Finding): number {
  const s = SEVERITY_INDEX[a.severity] - SEVERITY_INDEX[b.severity];
  if (s !== 0) return s;
  const c = CODE_ORDER.indexOf(a.code) - CODE_ORDER.indexOf(b.code);
  if (c !== 0) return c;
  const f = (a.file ?? "").localeCompare(b.file ?? "");
  if (f !== 0) return f;
  return a.key.localeCompare(b.key);
}
