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
    expect(text).toMatch(/more lines? of key material/);
  });

  // Regression: the value of a PEM key stops at the header line, so a rotated
  // key looked identical to the old one and diff said "files are identical".
  it("sees a rotated PEM body even when the header is unchanged", () => {
    const dir = makeRepo({
      "a.env": ["PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA1111111111", "-----END RSA PRIVATE KEY-----"].join("\n") + "\n",
      "b.env": ["PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA9999999999", "-----END RSA PRIVATE KEY-----"].join("\n") + "\n",
    });
    const report = diffFiles(path.join(dir, "a.env"), path.join(dir, "b.env"), "a.env", "b.env");
    expect(report.identical).toBe(false);
    expect(report.changed.map((e) => e.key)).toEqual(["PRIVATE_KEY"]);
    // Still masked even though the caller did not ask for a reveal.
    expect(formatDiffReport(report, { color: false })).not.toContain("MIIEowIBAAKCAQEA1111111111");
  });

  // Regression: a body that grew or shrank is a different key, but only the
  // line count differs - the header is byte identical.
  it("sees a PEM body whose line count changed", () => {
    const dir = makeRepo({
      "a.env": ["PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----", "AAAA", "-----END RSA PRIVATE KEY-----"].join("\n") + "\n",
      "b.env":
        ["PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----", "AAAA", "BBBB", "CCCC", "----" + "-END RSA PRIVATE KEY-----"].join("\n") + "\n",
    });
    const report = diffFiles(path.join(dir, "a.env"), path.join(dir, "b.env"), "a.env", "b.env");
    expect(report.identical).toBe(false);
    expect(report.changed.map((e) => e.key)).toEqual(["PRIVATE_KEY"]);
    // Three base64 lines. The -----END----- marker is not key material, so it
    // must not be counted - "+4 more lines" for a three-line body is the kind of
    // wrong-but-documented number that teaches users to distrust the report.
    expect(report.changed[0]?.pemLines).toBe(3);
  });

  // The suite above pins the count when the two sides differ. This one pins the
  // exact wording of the banner on both sides of the singular/plural boundary,
  // because "1 more line(s)" reads like a bug even when the number is right.
  it("counts only the key material lines and pluralises the banner", () => {
    const dir = makeRepo({
      "one.env": ["PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----", "AAAA", "-----END RSA PRIVATE KEY-----"].join("\n") + "\n",
      "one2.env": ["PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----", "ZZZZ", "-----END RSA PRIVATE KEY-----"].join("\n") + "\n",
      "two.env": ["PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----", "AAAA", "BBBB", "-----END RSA PRIVATE KEY-----"].join("\n") + "\n",
      "two2.env": ["PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----", "ZZZZ", "YYYY", "-----END RSA PRIVATE KEY-----"].join("\n") + "\n",
    });
    const single = diffFiles(path.join(dir, "one.env"), path.join(dir, "one2.env"), "one.env", "one2.env");
    expect(single.changed[0]?.pemLines).toBe(1);
    const singleText = formatDiffReport(single, { color: false });
    expect(singleText).toContain("+ 1 more line of key material");
    expect(singleText).not.toContain("line(s)");

    const plural = diffFiles(path.join(dir, "two.env"), path.join(dir, "two2.env"), "two.env", "two2.env");
    expect(plural.changed[0]?.pemLines).toBe(2);
    const pluralText = formatDiffReport(plural, { color: false });
    expect(pluralText).toContain("+ 2 more lines of key material");
    // Neither banner may quote the END marker line.
    expect(pluralText).not.toContain("+ 3 more");
  });

  // Regression: the body walk stopped at a blank line, the rest of the key fell
  // into the unparseable bucket, and that bucket used to be printed verbatim.
  it("never prints key material that sits behind a blank line", () => {
    const lines = (bodyA: string, bodyB: string): string[] => [
      "K=-----BEGIN RSA PRIVATE KEY-----",
      bodyA,
      "",
      bodyB,
      "-----END RSA PRIVATE KEY-----",
    ];
    const dir = makeRepo({
      "a.env": lines("BODYLINEAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "BODYLINEBBBBBBBBBBBBBBBBBBBBBBBBBBBB").join("\n") + "\n",
      "b.env": lines("BODYLINEAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "BODYLINEBBBBBBBBBBBBBBBBBBBBBBBBBBBB").join("\n") + "\n",
    });
    const report = diffFiles(path.join(dir, "a.env"), path.join(dir, "b.env"), "a.env", "b.env");
    const text = formatDiffReport(report, { color: false });
    expect(text).not.toContain("BODYLINE");
    // The digest still sees the body, so rotation is visible even with a blank line.
    const rotated = makeRepo({
      "a.env": lines("BODYLINEAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "BODYLINEBBBBBBBBBBBBBBBBBBBBBBBBBBBB").join("\n") + "\n",
      "b.env": lines("BODYLINEAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "BODYLINEZZZZZZZZZZZZZZZZZZZZZZZZZZZZ").join("\n") + "\n",
    });
    const rotatedReport = diffFiles(path.join(rotated, "a.env"), path.join(rotated, "b.env"), "a.env", "b.env");
    expect(rotatedReport.identical).toBe(false);
    expect(rotatedReport.changed.map((e) => e.key)).toEqual(["K"]);
    expect(formatDiffReport(rotatedReport, { color: false })).not.toContain("BODYLINE");
  });

  // Regression: lines that are not KEY=value assignments were dropped on the
  // floor, so a file with junk in the middle compared equal to one without it.
  it("does not call two files identical when their junk lines differ", () => {
    const dir = makeRepo({ "junk.env": "GOOD=1\nDIFFERENT JUNK HERE\nGOOD2=2\n", "junk2.env": "GOOD=1\nGOOD2=2\n" });
    const report = diffFiles(path.join(dir, "junk.env"), path.join(dir, "junk2.env"), "junk.env", "junk2.env");
    expect(report.identical).toBe(false);
    expect(report.invalidA.map((line) => line.line)).toEqual([2]);
    expect(report.invalidB).toEqual([]);
    const text = formatDiffReport(report, { color: false });
    expect(text).toContain("not a KEY=value assignment in A (1)");
    expect(text).toContain("line 2:");
    // The line is described, never quoted: an unparseable line is where secrets
    // end up, and stdout is the wrong place for them.
    expect(text).not.toContain("DIFFERENT JUNK HERE");
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

  // Regression: the body walk stopped at the first line that did not look like
  // base64, and a blank line is the cheapest way to be "not base64". One stray
  // empty line printed the entire key to stdout.
  it("masks through a blank line inside a PEM block", () => {
    const input =
      [
        "K=-----BEGIN RSA PRIVATE KEY-----",
        "BODYLINEAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "",
        "BODYLINEBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        "-----END RSA PRIVATE KEY-----",
        "AFTER=ok",
      ].join("\n") + "\n";
    const out = maskText(input);
    expect(out).not.toContain("BODYLINEAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(out).not.toContain("BODYLINEBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(out).not.toContain("-----END RSA PRIVATE KEY-----");
    expect(out).toContain("K=");
    expect(out).toContain("AFTER=ok");
  });

  // Regression: `cat key.pem >> .env` leaves the marker on its own line under an
  // empty value, which none of the earlier fixtures covered.
  it("masks a PEM block whose marker sits on its own line", () => {
    const input =
      [
        "PRIVATE_KEY=",
        "-----BEGIN RSA PRIVATE KEY-----",
        "BODYH1111AAAAAAAAAAAAAAAAAAAAAAAA",
        "BODYH2222BBBBBBBBBBBBBBBBBBBBBBBB",
        "-----END RSA PRIVATE KEY-----",
        "DEBUG=true",
      ].join("\n") + "\n";
    const out = maskText(input);
    expect(out).not.toContain("BODYH1111AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(out).not.toContain("BODYH2222BBBBBBBBBBBBBBBBBBBBBBBB");
    expect(out).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(out).not.toContain("-----END RSA PRIVATE KEY-----");
    expect(out).toContain("DEBUG=true");
  });

  // Regression: `mask` returned unparseable lines verbatim, so the one line
  // most likely to hold a leaked URL - a typo'd DATABASE_URL with no "=" -
  // came back in clear and the caller pasted it into an issue.
  it("masks secrets on a line that is not a KEY=value assignment", () => {
    const input = "GOOD=1\nDATABASE_URL postgres://admin:PA55W0RD_LEAK@db.internal/prod\n";
    const out = maskText(input);
    expect(out).not.toContain("PA55W0RD_LEAK");
    expect(out).toContain("GOOD=1");
    // Still one line per line: masking must not restructure the file.
    expect(out.split("\n")).toHaveLength(input.split("\n").length);
  });

  it("masks the value of a space-separated assignment", () => {
    const out = maskText("DB_PASSWORD hunter2secretvalue\nCOMMENT=ok\n");
    expect(out).not.toContain("hunter2secretvalue");
    expect(out).toContain("COMMENT=ok");
  });

  // RFC 7468 labels are case-insensitive; the first regex was not.
  it("masks a PEM block with a lowercase label", () => {
    const input =
      [
        "K=-----begin rsa private key-----",
        "BODYLOWERCASEAAAAAAAAAAAAAAAAAAAA",
        "-----end rsa private key-----",
        "DEBUG=true",
      ].join("\n") + "\n";
    const out = maskText(input);
    expect(out).not.toContain("BODYLOWERCASEAAAAAAAAAAAAAAAAAAAA");
    expect(out).not.toContain("-----end rsa private key-----");
    expect(out).toContain("DEBUG=true");
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