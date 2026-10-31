import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "envpulse-cli-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

interface Captured {
  code: number;
  out: string;
  err: string;
}

function run(argv: string[]): Captured {
  let out = "";
  let err = "";
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (chunk: string): boolean => {
    out += chunk;
    return true;
  };
  (process.stderr as { write: unknown }).write = (chunk: string): boolean => {
    err += chunk;
    return true;
  };
  try {
    const code = main(argv);
    return { code, out, err };
  } finally {
    (process.stdout as { write: unknown }).write = stdoutWrite;
    (process.stderr as { write: unknown }).write = stderrWrite;
  }
}

afterEach(() => {
  process.exitCode = 0;
});

describe("cli", () => {
  it("prints help with exit code 0", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("envpulse");
    expect(result.out).toContain("check");
    expect(result.out).toContain("diff");
    expect(result.out).toContain("sync");
  });

  it("prints the version", () => {
    const result = run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exits 2 with a usage error for an unknown command", () => {
    const result = run(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown command");
  });

  it("exits 2 for an unknown flag", () => {
    const result = run(["check", "--nope"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("nope");
  });

  it("check --json emits machine-readable JSON and exit 1 on a high finding", () => {
    const dir = makeRepo({ ".env.example": "PORT=3000\n", "src/app.ts": "process.env.MISSING_TOKEN;\n" });
    const result = run(["check", "--cwd", dir, "--json"]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.out) as { command: string; findings: { code: string }[] };
    expect(parsed.command).toBe("check");
    expect(parsed.findings.some((f) => f.code === "MISSING")).toBe(true);
  });

  it("check on a clean project exits 0", () => {
    const dir = makeRepo({ ".env.example": "PORT=3000\n", "src/app.ts": "process.env.PORT;\n" });
    const result = run(["check", "--cwd", dir]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("no problems found");
  });

  it("diff masks values unless --reveal is passed", () => {
    const dir = makeRepo({ "a.env": "TOKEN=alpha-real-value-1\n", "b.env": "TOKEN=beta-real-value-22\n" });
    const masked = run(["diff", path.join(dir, "a.env"), path.join(dir, "b.env")]);
    // Like GNU diff: 1 means "differences found", not a failure.
    expect(masked.code).toBe(1);
    expect(masked.out).not.toContain("alpha-real-value-1");
    const shown = run(["diff", path.join(dir, "a.env"), path.join(dir, "b.env"), "--reveal"]);
    expect(shown.out).toContain("alpha-real-value-1");
  });

  it("sync writes the target and reports what changed", () => {
    const dir = makeRepo({ "tpl.env": "A=\nB=\n", "target.env": "A=1\n" });
    const result = run(["sync", "--from", path.join(dir, "tpl.env"), "--to", path.join(dir, "target.env")]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("added 1 key(s)");
    expect(readFileSync(path.join(dir, "target.env"), "utf8")).toBe("A=1\nB=\n");
  });

  it("sync --dry-run does not touch the disk", () => {
    const dir = makeRepo({ "tpl.env": "A=\nB=\n", "target.env": "A=1\n" });
    const result = run(["sync", "--from", path.join(dir, "tpl.env"), "--to", path.join(dir, "target.env"), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("nothing written");
    expect(readFileSync(path.join(dir, "target.env"), "utf8")).toBe("A=1\n");
  });

  it("sync refuses to overwrite an existing output without --force", () => {
    const dir = makeRepo({ "src/app.ts": "process.env.PORT;\n", ".env.example": "OLD=1\n" });
    const result = run(["init", "--from-code", "--cwd", dir]);
    expect(result.code).toBe(1);
    expect(result.err.toLowerCase()).toContain("exist");
  });

  it("init --from-code --dry-run prints the generated skeleton", () => {
    const dir = makeRepo({ "src/app.ts": "process.env.PORT;\nprocess.env.DB_URL;\n" });
    const result = run(["init", "--from-code", "--cwd", dir, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("DB_URL=");
    expect(result.out).toContain("PORT=");
  });

  // Regression: --cwd was resolved but never checked, so a typo produced a clean
  // "no .env files found" report with exit 0 - a green CI for a path that does
  // not exist.
  it("exits 2 when --cwd does not exist", () => {
    const dir = makeRepo({});
    const missing = path.join(dir, "nope", "not", "here");
    for (const command of ["check", "init"]) {
      const result = run([command, "--cwd", missing, "--from-code"]);
      expect(result.code).toBe(2);
      expect(result.err).toContain("does not exist");
      expect(result.out).toBe("");
    }
  });

  it("exits 2 when --cwd points at a file instead of a directory", () => {
    const dir = makeRepo({ "a.env": "A=1\n" });
    const result = run(["check", "--cwd", path.join(dir, "a.env")]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("not a directory");
  });
  it("reports an unreadable input file as a usage error", () => {
    const dir = makeRepo({ "a.env": "A=1\n" });
    const result = run(["diff", path.join(dir, "a.env"), path.join(dir, "nope.env")]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("nope.env");
  });
});