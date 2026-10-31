import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnvText } from "../src/parser.js";
import { matchUnsafe } from "../src/rules.js";

// Regression test for the demo fixtures. This repository used to commit
// examples/demo-app/.env. A tool whose entire purpose is catching secrets in
// committed .env files cannot ship one of its own: every reviewer re-flagged
// it, and the fixture survived only because its Stripe value happened to be
// shorter than the rule threshold. The fixture is generated now, and these
// tests are what keeps it out of git.

const repo = fileURLToPath(new URL("..", import.meta.url));
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];

function readRepoFile(relative: string): string {
  return readFileSync(path.join(repo, relative), "utf8");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("demo fixtures", () => {
  it.skipIf(!gitAvailable)("keeps every generated .env out of git", () => {
    const listed = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" });
    expect(listed.status).toBe(0);
    const tracked = listed.stdout.split("\0").filter((entry) => entry !== "");
    const envFiles = tracked.filter((entry) => path.posix.basename(entry) === ".env");
    expect(envFiles).toEqual([]);
  });

  it("ignores both generated fixtures", () => {
    const ignore = readRepoFile(".gitignore");
    expect(ignore).toContain("examples/demo-app/.env");
    expect(ignore).toContain("examples/leaky/.env.example");
  });

  it("wires both generators into a single npm script", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
    const script = pkg.scripts["demo:fixtures"];
    expect(script).toBeDefined();
    expect(script).toContain("scripts/make-demo-app.mjs");
    expect(script).toContain("scripts/make-leaky-fixture.mjs");
  });

  it("generates the .env the README demo scans", () => {
    // Run a copy of the generator against a throwaway tree so the test never
    // writes into the repository it is testing.
    const root = mkdtempSync(path.join(tmpdir(), "envpulse-demo-"));
    dirs.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    cpSync(path.join(repo, "scripts", "make-demo-app.mjs"), path.join(root, "scripts", "make-demo-app.mjs"));
    const run = spawnSync(process.execPath, [path.join(root, "scripts", "make-demo-app.mjs")], {
      encoding: "utf8",
    });
    expect(run.status).toBe(0);

    const text = readFileSync(path.join(root, "examples", "demo-app", ".env"), "utf8");
    const file = parseEnvText(text, { path: ".env" });
    expect(file.invalid).toEqual([]);
    expect(file.entries).toHaveLength(6);
    expect(new Set(file.entries.map((entry) => entry.key)).size).toBe(5);
    expect(file.duplicates.map((dup) => dup.key)).toEqual(["PORT"]);
    expect(file.duplicates[0]?.lines).toEqual([2, 7]);
  });

  it("keeps the generated secret under every rule threshold", () => {
    // The README claims the demo fixture produces no UNSAFE row even if it
    // were tracked. That claim rests on the value being too short to look
    // like a live key, so it is pinned here rather than trusted.
    const root = mkdtempSync(path.join(tmpdir(), "envpulse-demo-"));
    dirs.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    cpSync(path.join(repo, "scripts", "make-demo-app.mjs"), path.join(root, "scripts", "make-demo-app.mjs"));
    spawnSync(process.execPath, [path.join(root, "scripts", "make-demo-app.mjs")], { encoding: "utf8" });

    const text = readFileSync(path.join(root, "examples", "demo-app", ".env"), "utf8");
    const file = parseEnvText(text, { path: ".env" });
    const offenders = file.entries
      .map((entry) => ({ key: entry.key, rule: matchUnsafe(entry.value) }))
      .filter((entry) => entry.rule !== null);
    expect(offenders).toEqual([]);
  });
});
