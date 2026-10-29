import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractEnvKeys, locateEnvKeys, scanSource, sourceKind } from "../src/scan.js";

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "envpulse-scan-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("sourceKind", () => {
  it("maps known extensions", () => {
    expect(sourceKind("a.ts")).toBe("js");
    expect(sourceKind("a.mjs")).toBe("js");
    expect(sourceKind("a.tsx")).toBe("js");
    expect(sourceKind("a.py")).toBe("py");
    expect(sourceKind("a.sh")).toBe("sh");
    expect(sourceKind("a.md")).toBe("unknown");
    expect(sourceKind("Makefile")).toBe("unknown");
  });
});

describe("extractEnvKeys", () => {
  it("finds process.env dot and bracket access", () => {
    const keys = extractEnvKeys('const a = process.env.PORT;\nconst b = process.env["DB_URL"];\n', "js");
    expect(keys.sort()).toEqual(["DB_URL", "PORT"]);
  });

  it("finds import.meta.env and Deno.env.get", () => {
    const keys = extractEnvKeys('const v = import.meta.env.VITE_FLAG;\nconst d = Deno.env.get("DENO_VAR");\n', "js");
    expect(keys.sort()).toEqual(["DENO_VAR", "VITE_FLAG"]);
  });

  it("finds python os.environ and os.getenv forms", () => {
    const source = 'a = os.environ["A_VAR"]\nb = os.environ.get("B_VAR")\nc = os.getenv("C_VAR")\n';
    expect(extractEnvKeys(source, "py").sort()).toEqual(["A_VAR", "B_VAR", "C_VAR"]);
  });

  it("finds shell $VAR and ${VAR:-default} but skips shell builtins", () => {
    const source = "echo $APP_ENV\necho ${DB_HOST:-localhost}\necho $PATH\n";
    expect(extractEnvKeys(source, "sh").sort()).toEqual(["APP_ENV", "DB_HOST"]);
  });

  it("returns nothing for unknown file kinds", () => {
    expect(extractEnvKeys("process.env.SECRET", "unknown")).toEqual([]);
  });

  it("locateEnvKeys returns 1-based line numbers", () => {
    const source = "// header\nconst a = process.env.FOO;\n\nconst b = process.env.BAR;\n";
    const found = locateEnvKeys(source, "js", new Set(["FOO", "BAR"]));
    expect(found.get("FOO")).toEqual([2]);
    expect(found.get("BAR")).toEqual([4]);
  });
});

describe("scanSource", () => {
  it("scans a fake repo and reports files scanned plus hit locations", () => {
    const dir = makeRepo({
      "src/config.ts": "export const port = Number(process.env.PORT ?? 3000);\n",
      "src/db.ts": 'export const url = process.env["DATABASE_URL"];\n',
      "scripts/deploy.sh": "set -eu\necho \"deploy to $TARGET_ENV\"\n",
      "tools/report.py": 'import os\nkey = os.getenv("API_KEY")\n',
      "README.md": "process.env.NOT_CODE\n",
    });
    const result = scanSource(dir);
    expect([...result.vars.keys()].sort()).toEqual(["API_KEY", "DATABASE_URL", "PORT", "TARGET_ENV"]);
    expect(result.filesScanned).toBe(4);
  });

  it("skips node_modules, dist and .git directories", () => {
    const dir = makeRepo({
      "src/app.ts": "process.env.REAL_VAR;\n",
      "node_modules/pkg/index.js": "process.env.FAKE_VAR;\n",
      "dist/bundle.js": "process.env.FAKE_VAR;\n",
      ".git/hooks/x.js": "process.env.FAKE_VAR;\n",
    });
    const result = scanSource(dir);
    expect([...result.vars.keys()]).toEqual(["REAL_VAR"]);
  });

  it("records one hit per line for repeated reads in different files", () => {
    const dir = makeRepo({
      "src/a.ts": "process.env.OK;\nprocess.env.OTHER;\n",
      "src/b.ts": "process.env.OK;\n",
    });
    const result = scanSource(dir);
    const ok = result.vars.get("OK") ?? [];
    expect(ok).toHaveLength(2);
    expect(ok[0]).toMatchObject({ file: "src/a.ts", line: 1 });
    expect(ok[1]).toMatchObject({ file: "src/b.ts", line: 1 });
  });

  it("returns an empty result for an empty directory", () => {
    const dir = makeRepo({});
    const result = scanSource(dir);
    expect(result.filesScanned).toBe(0);
    expect(result.vars.size).toBe(0);
  });
});
