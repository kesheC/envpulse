import type {
  CheckReport,
  DiffReport,
  Finding,
  FindingCode,
  InvalidLine,
  Severity,
} from "./types.js";

export const VERSION = "0.1.8";

export const SEVERITY_ORDER: Severity[] = ["high", "medium", "low"];

const LABEL: Record<FindingCode, string> = {
  MISSING: "MISSING",
  UNUSED: "UNUSED",
  DRIFT: "DRIFT",
  DUPLICATE: "DUPLICATE",
  UNSAFE: "UNSAFE",
  EMPTY: "EMPTY",
  INVALID: "INVALID",
};

const SEVERITY_TAG: Record<Severity, string> = {
  high: "HIGH",
  medium: "MED",
  low: "LOW",
};

export interface FormatOptions {
  /** Disable ANSI colours (auto-detected from TTY by the CLI). */
  color?: boolean;
  /** Show full values instead of masked ones. */
  reveal?: boolean;
}

function painter(enabled: boolean) {
  const wrap = (code: string) => (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    yellow: wrap("33"),
    cyan: wrap("36"),
    green: wrap("32"),
  };
}

/** Group findings by code, keeping the canonical order. */
export function groupFindings(findings: Finding[]): Map<FindingCode, Finding[]> {
  const order: FindingCode[] = ["MISSING", "UNSAFE", "DRIFT", "DUPLICATE", "INVALID", "EMPTY", "UNUSED"];
  const map = new Map<FindingCode, Finding[]>();
  for (const code of order) {
    const bucket = findings.filter((f) => f.code === code);
    if (bucket.length > 0) {
      // INVALID findings are anchored to a line number, so reading them in file
      // order beats alphabetical order.
      if (code === "INVALID") bucket.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
      else bucket.sort((a, b) => a.key.localeCompare(b.key));
      map.set(code, bucket);
    }
  }
  return map;
}

/** Render a human readable check report. */
export function formatCheckReport(report: CheckReport, options: FormatOptions = {}): string {
  const c = painter(options.color === true);
  const lines: string[] = [];

  lines.push(c.bold(`envpulse check`) + c.dim(`  (v${report.version})`));
  lines.push(c.dim(`cwd: ${report.cwd}`));
  lines.push("");

  if (report.envFiles.length === 0) {
    lines.push(c.yellow("no .env files found") + " - nothing to cross-check.");
  } else {
    lines.push(c.bold("env files"));
    for (const file of report.envFiles) {
      const kind = file.kind === "example" ? c.cyan("example") : "    env";
      const dup = file.duplicates.length > 0 ? c.yellow(`  ${file.duplicates.length} duplicate`) : "";
      lines.push(`  ${kind}  ${file.path}  ${c.dim(file.keys + " keys")}${dup}`);
    }
  }
  lines.push("");
  lines.push(c.dim(`scanned ${report.sourceFiles} source file(s), ${report.variablesRead.length} variable(s) read by code`));
  lines.push("");

  if (report.findings.length === 0) {
    lines.push(c.green("no problems found"));
  } else {
    const grouped = groupFindings(report.findings);
    for (const [code, bucket] of grouped) {
      lines.push(c.bold(`${LABEL[code]} (${bucket.length})`));
      for (const finding of bucket) {
        lines.push(formatFinding(finding, c, options));
      }
      lines.push("");
    }
  }

  for (const note of report.notes) lines.push(c.dim(note));

  const { high, medium, low } = report.counts;
  const summary = `${high} high, ${medium} medium, ${low} low`;
  lines.push("");
  lines.push(
    report.findings.length === 0
      ? c.green(`0 problems`)
      : (high > 0 ? c.red(summary) : c.yellow(summary)) + c.dim(`  -> exit ${report.exitCode}`),
  );

  return lines.join("\n");
}

function formatFinding(
  finding: Finding,
  c: ReturnType<typeof painter>,
  options: FormatOptions,
): string {
  const tag = `[${SEVERITY_TAG[finding.severity]}]`;
  const coloredTag =
    finding.severity === "high" ? c.red(tag) : finding.severity === "medium" ? c.yellow(tag) : c.dim(tag);
  const where = finding.file !== undefined ? c.dim(`  ${finding.file}${finding.line !== undefined ? ":" + finding.line : ""}`) : "";
  const rows: string[] = [`  ${coloredTag} ${finding.key}${where}`];
  rows.push(`         ${finding.message}`);
  if (finding.hits !== undefined) {
    const shown = finding.hits.slice(0, 3);
    for (const hit of shown) {
      rows.push(c.dim(`         at ${hit.file}:${hit.line}`));
    }
    if (finding.hits.length > shown.length) {
      rows.push(c.dim(`         ... and ${finding.hits.length - shown.length} more`));
    }
  }
  if (finding.files !== undefined) {
    rows.push(c.dim(`         in ${finding.files.join(", ")}`));
  }
  return rows.join("\n");
}

/**
 * One unparseable line, described without quoting it.
 *
 * Length plus a short digest is enough to answer the only two questions this
 * report is asked: "did this line change?" and "is this the same junk on both
 * sides?". It is not enough to reconstruct a secret.
 */
function describeRow(row: InvalidLine): string {
  const what = row.keyMaterial ? "looks like key material, omitted" : `${row.length} bytes, omitted`;
  return `line ${row.line}: ${what}`;
}

/** Render a human readable diff report. */
export function formatDiffReport(report: DiffReport, options: FormatOptions = {}): string {
  const c = painter(options.color === true);
  const lines: string[] = [];
  lines.push(c.bold("envpulse diff") + c.dim(`  (v${report.version})`));
  lines.push(c.dim(`A: ${report.a.path} (${report.a.keys} keys)`));
  lines.push(c.dim(`B: ${report.b.path} (${report.b.keys} keys)`));
  lines.push("");

  if (report.identical) {
    lines.push(c.green("files are identical"));
    return lines.join("\n");
  }

  if (report.onlyA.length > 0) {
    lines.push(c.bold(`only in A (${report.onlyA.length})`));
    for (const entry of report.onlyA) lines.push(`  ${c.cyan("-")} ${entry.key}`);
    lines.push("");
  }
  if (report.onlyB.length > 0) {
    lines.push(c.bold(`only in B (${report.onlyB.length})`));
    for (const entry of report.onlyB) lines.push(`  ${c.cyan("+")} ${entry.key}`);
    lines.push("");
  }
  if (report.changed.length > 0) {
    lines.push(c.bold(`changed values (${report.changed.length})`));
    for (const entry of report.changed) {
      lines.push(`  ${c.yellow("~")} ${entry.key}`);
      lines.push(c.dim(`      A: ${entry.a}`));
      lines.push(c.dim(`      B: ${entry.b}`));
      if (entry.pemLines !== undefined) {
        const noun = entry.pemLines === 1 ? "line" : "lines";
        lines.push(c.dim(`      + ${entry.pemLines} more ${noun} of key material`));
      }
    }
    lines.push("");
  }

  // Lines that are not a KEY=value assignment are not keys, but they are still
  // content: noticing them is the difference between "identical" and "a typo
  // swallowed a variable".
  //
  // They are described, never quoted. An unparseable line is exactly where a
  // pasted private key or a `DATABASE_URL postgres://user:pass@host` ends up,
  // and printing it here used to put key material straight on stdout - the one
  // thing this tool exists to prevent. `check` never printed them either, so
  // this also ends the disagreement between the two commands.
  const sameInvalid =
    report.invalidA.length === report.invalidB.length &&
    report.invalidA.every((line, index) => line.digest === report.invalidB[index]?.digest);
  if (!sameInvalid) {
    const sides: { label: string; rows: InvalidLine[] }[] = [
      { label: "A", rows: report.invalidA },
      { label: "B", rows: report.invalidB },
    ];
    for (const side of sides) {
      if (side.rows.length === 0) continue;
      lines.push(c.bold(`not a KEY=value assignment in ${side.label} (${side.rows.length})`));
      for (const row of side.rows) {
        lines.push(`  ${c.cyan("-")} ${describeRow(row)}`);
      }
      lines.push("");
    }
  }

  lines.push(c.dim(`${report.same} key(s) identical`));
  return lines.join("\n");
}