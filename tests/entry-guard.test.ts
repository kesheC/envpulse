import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

// Regression test for the entry guard. This repo used to compare
// process.argv[1] with import.meta.url as raw strings. Node resolves
// import.meta.url to the real path but leaves process.argv[1] as written, and
// npm installs a bin as a link, so the two never matched through a link: the
// CLI exited 0 having printed nothing. CI only checked the exit code, so it
// stayed green.
//
// A file symlink would be the obvious fixture, but Windows refuses those
// without developer mode (EPERM), so the test links the whole dist directory
// and reaches the entry point through it. That resolves exactly the same way.

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const entry = path.join(dist, "cli.js");
const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
}).version;
const dirs: string[] = [];

function entryThroughLink(): string {
  const root = mkdtempSync(path.join(tmpdir(), "entry-guard-"));
  dirs.push(root);
  const shim = path.join(root, "node_modules", "envpulse", "dist");
  mkdirSync(path.dirname(shim), { recursive: true });
  symlinkSync(dist, shim, process.platform === "win32" ? "junction" : "dir");
  return path.join(shim, "cli.js");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("entry guard", () => {
  it("runs when the entry point is reached through a link, like a bin shim", () => {
    const result = spawnSync(process.execPath, [entryThroughLink(), "--version"], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(version);
    expect(result.status).toBe(0);
  });

  it("stays quiet when the module is merely imported", () => {
    // A guard that always returns true would print the usage text here.
    const script = "await import(" + JSON.stringify(pathToFileURL(entry).href) + ");";
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });
});
