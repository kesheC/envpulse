import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diffFiles } from "../src/diff.js";
import { syncEnvFiles, maskText } from "../src/fix.js";
import { formatDiffReport } from "../src/report.js";

// Assembled from fragments so GitHub push protection does not reject the repo
// (see tests/rules.test.ts for the rationale).
const stripeShort = "sk_" + "live_" + "abcdefghijklmnop";

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "envpulse-fix-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("diffFiles", () => {
  it("classifies added, removed and changed keys", () => {
    const dir = makeRepo({ "a.env": "SHARED=one\nONLY_A=1\nCHANGED=same-name\n", "b.env": "SHARED=one\nONLY_B=2\nCHANGED=different\n" });
    const report = diffFiles(path.join(dir, "a.env"), path.join(dir, "b.env"), "a.env", "b.env");
    expect(report.onlyB.map((e) => e.key)).toEqual(["ONLY_B"]);
    expect(report.onlyA.map((e) => e.key)).toEqual(["ONLY_A"]);
    expect(report.changed.map((e) => e.key)).toEqual(["CHANGED"]);
    expect(report.same).toBe(1);
  });

  it("masks values by default and reveals with the flag", () => {
    const dir = makeRepo({ "a.env": "TOKEN=supersecretvalue\n", "b.env": "TOKEN=anothersecretvalue\n" });
    const masked = diffFiles(path.join(dir, "a.env"), path.join(dir, "b.env"), "a.env", "b.env");
    expect(formatDiffReport(masked, { color: false })).not.toContain("supersecretvalue");
    const revealed = diffFiles(path.join(dir, "a.env"), path.join(dir, "b.env"), "a.env", "b.env", { reveal: true });
    expect(formatDiffReport(revealed, { color: false })).toContain("supersecretvalue");
  });

  // Regression: a PEM header is the only part of the key that fits in one
  // .env value, so revealing it with --reveal handed out the block opener.
  it("keeps PEM block headers masked even when revealing", () => {
    const aText = ["PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----", "AAAAbody1", "-----END RSA PRIVATE KEY-----", "TOKEN=plainvalue123"].join("\n") + "\n";
    const bText = ["PRIVATE_KEY=-----BEGIN OPENSSH PRIVATE KEY-----", "BBBBbody2", "-----END OPENSSH PRIVATE KEY-----", "TOKEN=othervalue456"].join("\n") + "\n";
    const dir = makeRepo({ "a.env": aText, "b.env": bText });
    const revealed = diffFiles(path.join(dir, "a.env"), path.join(dir, "b.env"), "a.env", "b.env", { reveal: true });
    const text = formatDiffReport(revealed, { color: false });
    expect(text).toContain("plainvalue123");
    expect(text).toContain("othervalue456");
    expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(text).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(text).toContain("more line(s) of key material");
  });

  it("returns an empty diff for identical files", () => {
    const dir = makeRepo({ "a.env": "A=1\nB=2\n", "b.env": "A=1\nB=2\n" });
    const report = diffFiles(path.join(dir, "a.env"), path.join(dir, "b.env"), "a.env", "b.env");
    expect(report.onlyA).toEqual([]);
    expect(report.onlyB).toEqual([]);
    expect(report.changed).toEqual([]);
    expect(report.same).toBe(2);
  });
});

describe("maskText", () => {
  it("masks every assignment while keeping keys and comments", () => {
    const input = "# top comment\nAPI_KEY=" + stripeShort + "\nDEBUG=true\n";
    const out = maskText(input);
    expect(out).toContain("# top comment");
    expect(out).toContain("API_KEY=");
    expect(out).not.toContain(stripeShort);
    expect(out).toContain("DEBUG=true");
  });

  // Regression: a PEM key body spans lines, so masking only the assignment line
  // leaked the key material in clear.
  it("masks every line of a multi-line PEM block", () => {
    const input =
      [
        "PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEAsecretbody1234",
        "AAAABBBBCCCCDDDDEEEEFFFF",
        "-----END RSA PRIVATE KEY-----",
        "OTHER=x",
      ].join("\n") + "\n";
    const out = maskText(input);
    expect(out).not.toContain("MIIEowIBAAKCAQEAsecretbody1234");
    expect(out).not.toContain("AAAABBBBCCCCDDDDEEEEFFFF");
    expect(out).not.toContain("-----END RSA PRIVATE KEY-----");
    expect(out).toContain("PRIVATE_KEY=");
    expect(out).toContain("OTHER=x");
    expect(out.split("\n").filter((line) => line !== "")).toHaveLength(5);
  });

  // Regression: the leak flag is value-driven, so a PEM blob under a harmless
  // key name (CERT_BLOB, DB_PASSWORD...) must be masked too.
  it("masks a PEM block that starts on a later line under a dull key name", () => {
    const input =
      [
        "CERT=-----BEGIN CERTIFICATE-----",
        "MIICertBodyLineOne",
        "MIICertBodyLineTwo",
        "-----END CERTIFICATE-----",
        "DEBUG=true",
      ].join("\n") + "\n";
    const out = maskText(input);
    expect(out).not.toContain("MIICertBodyLineOne");
    expect(out).not.toContain("MIICertBodyLineTwo");
    expect(out).not.toContain("-----END CERTIFICATE-----");
    expect(out).toContain("DEBUG=true");
  });

  it("leaves a single-line value alone when the PEM block is already closed", () => {
    const input = "SIGNING_NOTE=the -----BEGIN line is documented in the README\n";
    const out = maskText(input);
    expect(out).toBe(input);
  });
});

describe("syncEnvFiles", () => {
  it("adds missing keys to the target and preserves existing order", () => {
    const dir = makeRepo({ "tpl.env": "A=\nB=\nC=\n", "target.env": "C=3\nA=1\n" });
    const result = syncEnvFiles({
      from: path.join(dir, "tpl.env"),
      to: path.join(dir, "target.env"),
      dryRun: false,
    });
    expect(result.added).toBe(1);
    expect(result.staleKeys).toEqual([]);
    const written = readFileSync(path.join(dir, "target.env"), "utf8");
    // B is anchored before C: C is the next template key that already exists in the target.
    expect(written).toBe("B=\nC=3\nA=1\n");
  });

  it("does not write in dry-run mode", () => {
    const dir = makeRepo({ "tpl.env": "A=\nB=\n", "target.env": "A=1\n" });
    const before = readFileSync(path.join(dir, "target.env"), "utf8");
    const result = syncEnvFiles({ from: path.join(dir, "tpl.env"), to: path.join(dir, "target.env"), dryRun: true });
    expect(result.added).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(readFileSync(path.join(dir, "target.env"), "utf8")).toBe(before);
  });

  it("reports stale keys without deleting them", () => {
    const dir = makeRepo({ "tpl.env": "A=\n", "target.env": "A=1\nOLD=stale\n" });
    const result = syncEnvFiles({ from: path.join(dir, "tpl.env"), to: path.join(dir, "target.env"), dryRun: false });
    expect(result.staleKeys).toEqual(["OLD"]);
    expect(readFileSync(path.join(dir, "target.env"), "utf8")).toContain("OLD=stale");
  });

  it("creates the target file when it does not exist", () => {
    const dir = makeRepo({ "tpl.env": "# comment\nA=\n" });
    const target = path.join(dir, "new.env");
    expect(existsSync(target)).toBe(false);
    const result = syncEnvFiles({ from: path.join(dir, "tpl.env"), to: target, dryRun: false });
    expect(result.added).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("# comment\nA=\n");
  });

  it("preserves CRLF line endings of the target", () => {
    const dir = makeRepo({ "tpl.env": "A=\r\nB=\r\n", "target.env": "A=1\r\n" });
    const result = syncEnvFiles({ from: path.join(dir, "tpl.env"), to: path.join(dir, "target.env"), dryRun: false });
    expect(result.added).toBe(1);
    expect(readFileSync(path.join(dir, "target.env"), "utf8")).toBe("A=1\r\nB=\r\n");
  });

  it("is a no-op when the target already has every key", () => {
    const dir = makeRepo({ "tpl.env": "A=\nB=\n", "target.env": "A=1\nB=2\n" });
    const result = syncEnvFiles({ from: path.join(dir, "tpl.env"), to: path.join(dir, "target.env"), dryRun: false });
    expect(result.added).toBe(0);
    expect(result.changes).toEqual([]);
  });
});