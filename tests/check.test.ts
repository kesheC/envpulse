import { spawnSync } from "node:child_process";
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

const gitAvailable = (() => {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

/** A throwaway git repo whose committed files are exactly `commit`. */
function gitRepo(files: Record<string, string>, commit: string[]): string {
  const dir = makeRepo(files);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(dir, "absent-gitconfig"),
    GIT_AUTHOR_NAME: "envpulse",
    GIT_AUTHOR_EMAIL: "envpulse@example.test",
    GIT_COMMITTER_NAME: "envpulse",
    GIT_COMMITTER_EMAIL: "envpulse@example.test",
    GIT_TERMINAL_PROMPT: "0",
  };
  const run = (args: string[]): void => {
    spawnSync("git", args, { cwd: dir, env, stdio: "ignore" });
  };
  run(["init", "--quiet"]);
  run(["-c", "core.autocrlf=false", "add", "--", ...commit]);
  run(["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
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

  it("reports UNSAFE for a real secret in an example file and can be disabled", () => {
    const files = {
      ".env.example": "API_KEY=" + stripeLive + "\n",
      "src/app.ts": "process.env.API_KEY;\n",
    };
    const dir = makeRepo(files);
    const report = checkProject({ cwd: dir });
    const unsafe = report.findings.filter((f) => f.code === "UNSAFE");
    expect(unsafe.map((f) => f.rule)).toEqual(["stripe-live"]);
    expect(unsafe[0]?.severity).toBe("high");
    expect(unsafe[0]?.message).toContain("committed in a template file");
    expect(report.exitCode).toBe(1);
    const quiet = checkProject({ cwd: dir, noUnsafe: true });
    expect(quiet.findings.filter((f) => f.code === "UNSAFE")).toHaveLength(0);
  });

  it("still finds a real secret in an example file when git is unavailable", () => {
    // A plain directory is not a git repository: gitTrackedFiles() returns null
    // and case 1 must keep working instead of degrading to a silent no-op.
    const dir = makeRepo({
      ".env.example": "API_KEY=" + stripeLive + "\n",
      "src/app.ts": "process.env.API_KEY;\n",
    });
    const report = checkProject({ cwd: dir });
    expect(report.findings.filter((f) => f.code === "UNSAFE")).toHaveLength(1);
  });

  it("ignores a real secret in a .env that is not tracked by git", () => {
    const dir = makeRepo({
      ".env.example": "API_KEY=sk_test_placeholder_value\n",
      ".env": "API_KEY=" + stripeLive + "\n",
      "src/app.ts": "process.env.API_KEY;\n",
    });
    const report = checkProject({ cwd: dir });
    expect(report.findings.filter((f) => f.code === "UNSAFE")).toHaveLength(0);
  });

  // Regression: UNSAFE used to be enabled only for *.example files, so a real
  // .env full of live keys was reported as clean even after it was committed.
  it.skipIf(!gitAvailable)("reports a real secret in a plain .env that git tracks", () => {
    const dir = gitRepo(
      {
        ".env.example": "API_KEY=sk_test_placeholder_value\n",
        ".env": "API_KEY=" + stripeLive + "\n",
        "src/app.ts": "process.env.API_KEY;\n",
      },
      [".env"],
    );
    const report = checkProject({ cwd: dir });
    const unsafe = report.findings.filter((f) => f.code === "UNSAFE");
    expect(unsafe.map((f) => f.rule)).toEqual(["stripe-live"]);
    expect(unsafe[0]?.severity).toBe("high");
    expect(unsafe[0]?.message).toContain("tracked by git");
    expect(report.exitCode).toBe(1);
  });

  it.skipIf(!gitAvailable)("still reports a real secret in a tracked example file", () => {
    const dir = gitRepo({ ".env.example": "API_KEY=" + stripeLive + "\n", "src/app.ts": "process.env.API_KEY;\n" }, [
      ".env.example",
    ]);
    const report = checkProject({ cwd: dir });
    const unsafe = report.findings.filter((f) => f.code === "UNSAFE");
    expect(unsafe.map((f) => f.rule)).toEqual(["stripe-live"]);
    expect(unsafe[0]?.message).toContain("template file");
  });

  // Regression: a tracked plain .env whose secret-looking value is only a
  // placeholder must stay quiet, or every real-world repo turns red.
  it.skipIf(!gitAvailable)("does not flag placeholder values in a tracked .env", () => {
    const dir = gitRepo(
      {
        ".env.example": "API_KEY=sk_test_placeholder_value\n",
        ".env": "API_KEY=changeme\n",
        "src/app.ts": "process.env.API_KEY;\n",
      },
      [".env"],
    );
    const report = checkProject({ cwd: dir });
    expect(report.findings.filter((f) => f.code === "UNSAFE")).toHaveLength(0);
  });

  // Regression: a line that is not a KEY=value assignment was dropped silently,
  // so "DATABASE_URL postgres://..." (missing "=") vanished and the variable was
  // then reported as MISSING - pointing at the wrong problem entirely.
  it("reports INVALID for a line that is not a KEY=value assignment", () => {
    const dir = makeRepo({
      ".env.example": "PORT=3000\n",
      "src/app.ts": "process.env.PORT;\n",
      ".env": "PORT=3000\nDATABASE_URL postgres://localhost/app\n",
    });
    const report = checkProject({ cwd: dir });
    const invalid = report.findings.filter((f) => f.code === "INVALID");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.file).toBe(".env");
    expect(invalid[0]?.line).toBe(2);
    expect(invalid[0]?.severity).toBe("medium");
    expect(invalid[0]?.message).toContain("not a valid KEY=value assignment");
    // A medium finding must not turn the build red on its own.
    expect(report.exitCode).toBe(0);
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