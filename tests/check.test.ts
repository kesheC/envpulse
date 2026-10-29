import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkProject, discoverEnvFiles, pickTemplate } from "../src/checker.js";
import { formatCheckReport } from "../src/report.js";

// Assembled from fragments so GitHub push protection does not reject the repo
// (see tests/rules.test.ts for the rationale).
const stripeLive = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "envpulse-check-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function codesFor(report: ReturnType<typeof checkProject>): string[] {
  return report.findings.map((f) => f.code + ":" + f.key).sort();
}

describe("discoverEnvFiles / pickTemplate", () => {
  it("finds env files in the root and prefers the example as template", () => {
    const dir = makeRepo({ ".env": "A=1\n", ".env.example": "A=\n" });
    const files = discoverEnvFiles(dir);
    expect(files).toEqual([".env", ".env.example"]);
    expect(pickTemplate(files)).toBe(".env.example");
  });

  it("honours an explicit template", () => {
    const dir = makeRepo({ ".env": "A=1\n", ".env.local": "A=2\n" });
    const files = discoverEnvFiles(dir);
    expect(pickTemplate(files, ".env.local")).toBe(".env.local");
  });
});

describe("checkProject", () => {
  it("reports a clean project with no findings and exit code 0", () => {
    const dir = makeRepo({
      ".env.example": "PORT=3000\nDATABASE_URL=postgres://localhost/app\n",
      "src/app.ts": "const a = process.env.PORT;\nconst b = process.env.DATABASE_URL;\n",
    });
    const report = checkProject({ cwd: dir });
    expect(report.findings).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.counts).toEqual({ high: 0, medium: 0, low: 0 });
    expect(report.variablesRead).toEqual(["DATABASE_URL", "PORT"]);
  });

  it("reports MISSING for a variable read by code but absent from the template", () => {
    const dir = makeRepo({
      ".env.example": "PORT=3000\n",
      "src/app.ts": "process.env.PORT;\nprocess.env.SECRET_TOKEN;\n",
    });
    const report = checkProject({ cwd: dir });
    const missing = report.findings.filter((f) => f.code === "MISSING");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.key).toBe("SECRET_TOKEN");
    expect(missing[0]?.severity).toBe("high");
    expect(missing[0]?.hits?.[0]).toMatchObject({ file: "src/app.ts", line: 2 });
    expect(report.exitCode).toBe(1);
  });

  it("reports UNUSED for a template key the code never reads", () => {
    const dir = makeRepo({ ".env.example": "PORT=3000\nUNUSED_ONE=leftover\n", "src/app.ts": "process.env.PORT;\n" });
    const report = checkProject({ cwd: dir });
    expect(report.findings.filter((f) => f.code === "UNUSED").map((f) => f.key)).toEqual(["UNUSED_ONE"]);
    expect(report.exitCode).toBe(0);
  });

  it("reports DRIFT when env files disagree on keys", () => {
    const dir = makeRepo({
      ".env.example": "A=a\nB=b\n",
      ".env": "A=1\nC=3\n",
      "src/app.ts": "process.env.A; process.env.B; process.env.C;\n",
    });
    const report = checkProject({ cwd: dir });
    const drift = report.findings.filter((f) => f.code === "DRIFT").map((f) => f.key);
    expect(drift).toEqual(["B", "C"]);
  });

  it("reports DUPLICATE with line numbers", () => {
    const dir = makeRepo({ ".env.example": "A=first\nB=b\nA=again\n", "src/app.ts": "process.env.A; process.env.B;\n" });
    const report = checkProject({ cwd: dir });
    const dup = report.findings.find((f) => f.code === "DUPLICATE");
    expect(dup?.key).toBe("A");
    expect(dup?.message).toContain("1, 3");
    expect(dup?.severity).toBe("medium");
  });

  it("reports UNSAFE only for example files and can be disabled", () => {
    const files = {
      ".env.example": "API_KEY=" + stripeLive + "\n",
      "src/app.ts": "process.env.API_KEY;\n",
    };
    const dir = makeRepo(files);
    const report = checkProject({ cwd: dir });
    expect(report.findings.filter((f) => f.code === "UNSAFE").map((f) => f.rule)).toEqual(["stripe-live"]);
    expect(report.exitCode).toBe(1);
    const quiet = checkProject({ cwd: dir, noUnsafe: true });
    expect(quiet.findings.filter((f) => f.code === "UNSAFE")).toHaveLength(0);
  });

  it("does not report UNSAFE for a real .env file", () => {
    const dir = makeRepo({
      ".env.example": "API_KEY=sk_test_placeholder_value\n",
      ".env": "API_KEY=" + stripeLive + "\n",
      "src/app.ts": "process.env.API_KEY;\n",
    });
    const report = checkProject({ cwd: dir });
    expect(report.findings.filter((f) => f.code === "UNSAFE")).toHaveLength(0);
  });

  it("reports EMPTY as a low severity finding", () => {
    const dir = makeRepo({ ".env.example": "A=\n", "src/app.ts": "process.env.A;\n" });
    const report = checkProject({ cwd: dir });
    const empty = report.findings.filter((f) => f.code === "EMPTY");
    expect(empty.map((f) => f.key)).toEqual(["A"]);
    expect(empty[0]?.severity).toBe("low");
    expect(report.exitCode).toBe(0);
  });

  it("notes the absence of a template instead of inventing MISSING findings", () => {
    const dir = makeRepo({ "src/app.ts": "process.env.SOMETHING;\n" });
    const report = checkProject({ cwd: dir });
    expect(report.findings.filter((f) => f.code === "MISSING")).toHaveLength(0);
    expect(report.notes.join(" ")).toContain("no template env file");
  });

  it("returns an empty report for a directory with nothing in it", () => {
    const dir = makeRepo({});
    const report = checkProject({ cwd: dir });
    expect(report.envFiles).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it("sorts findings by severity and renders a stable human report", () => {
    const dir = makeRepo({
      ".env.example": "UNUSED_ONE=leftover\n",
      "src/app.ts": "process.env.MISSING_ONE;\n",
    });
    const report = checkProject({ cwd: dir });
    const first = report.findings[0];
    expect(first?.code).toBe("MISSING");
    const text = formatCheckReport(report, { color: false });
    expect(text).toContain("MISSING (1)");
    expect(text).toContain("UNUSED (1)");
    expect(text).toContain("exit 1");
    expect(text).not.toContain("\u001b[");
  });
});