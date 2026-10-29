import { describe, expect, it } from "vitest";
// Credential-shaped fixtures are assembled from fragments on purpose. GitHub push
// protection rejects any push whose file content contains a Stripe/Slack/GitHub
// lookalike, even one that is obviously synthetic; splitting the literal keeps the
// test honest (matchUnsafe still receives the concatenated value) without tripping
// the scanner.
const stripeLive = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const stripeTest = "sk_" + "test_" + "placeholder_value";
const stripeShort = "sk_" + "live_" + "abcdefghijklmnop";
const awsAkid = "AKIA" + "IOSFODNN7EXAMPLE";
const slackToken = "xoxb-" + "123456789012" + "-abcdefghijklmnop";
import {
  UNSAFE_RULES,
  isHighEntropySecret,
  isPlaceholder,
  isSensitiveValue,
  matchUnsafe,
} from "../src/rules.js";
import { shannonEntropy } from "../src/util.js";

describe("matchUnsafe - positive cases", () => {
  it("flags a Stripe live key", () => {
    expect(matchUnsafe(stripeLive)?.id).toBe("stripe-live");
  });

  it("flags an AWS access key id", () => {
    expect(matchUnsafe(awsAkid)?.id).toBe("aws-akid");
  });

  it("flags a GitHub personal access token", () => {
    expect(matchUnsafe("ghp_" + "a".repeat(36))?.id).toBe("github-pat");
  });

  it("flags a PEM private key", () => {
    expect(matchUnsafe("-----BEGIN RSA PRIVATE KEY-----")?.id).toBe("private-key");
  });

  it("flags an OpenAI style key", () => {
    expect(matchUnsafe("sk-" + "a1B2c3D4".repeat(5))?.id).toBe("openai-key");
  });

  it("flags a postgres URL with an inline password", () => {
    expect(matchUnsafe("postgres://admin:sup3rs3cr3t@db.internal:5432/app")?.id).toBe("db-url-with-password");
  });

  it("flags a Slack token", () => {
    expect(matchUnsafe(slackToken)?.id).toBe("slack-token");
  });
});

describe("matchUnsafe - negative cases", () => {
  it("does not flag obvious placeholders", () => {
    const values = ["", "changeme", "xxxxx", "your-api-key-here", "<your-token>", "TODO", "${API_KEY}"];
    for (const value of values) {
      expect(matchUnsafe(value), value).toBeNull();
    }
  });

  it("does not flag short human readable values", () => {
    for (const value of ["3000", "localhost", "development", "true", "hello world"]) {
      expect(matchUnsafe(value), value).toBeNull();
    }
  });

  it("does not flag a long but low entropy string", () => {
    expect(matchUnsafe("a".repeat(64))).toBeNull();
  });

  it("does not flag a long words-only phrase", () => {
    expect(matchUnsafe("this is a reasonably long but dull sentence")).toBeNull();
  });
});

describe("isHighEntropySecret", () => {
  it("accepts a mixed alphabet random looking secret", () => {
    expect(isHighEntropySecret("aB3xK9mQ2pL7vN4rT8wY1zC6fH0jS5dG")).toBe(true);
  });

  it("rejects strings shorter than 32 characters", () => {
    expect(isHighEntropySecret("aB3xK9mQ2pL7vN4rT8wY1z")).toBe(false);
  });

  it("rejects values containing whitespace", () => {
    expect(isHighEntropySecret("aB3xK9mQ2pL7vN4rT8wY1zC6fH0jS5dG extra")).toBe(false);
  });

  it("rejects pure digit strings", () => {
    expect(isHighEntropySecret("1234567890123456789012345678901234")).toBe(false);
  });

  it("rejects lowercase-only identifiers with no digits", () => {
    expect(isHighEntropySecret("abcdefghijklmnopqrstuvwxyzabcdef")).toBe(false);
  });

  it("computes shannon entropy with the 0 bit / 1 bit / 2 bit anchors", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abab")).toBe(1);
    expect(shannonEntropy("abcd")).toBe(2);
  });
});

describe("rules table", () => {
  it("every rule has a non-empty id and description", () => {
    expect(UNSAFE_RULES.length).toBeGreaterThanOrEqual(10);
    for (const rule of UNSAFE_RULES) {
      expect(rule.id.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });

  it("rule ids are unique", () => {
    const ids = UNSAFE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("isSensitiveValue", () => {
  it("masks a mundane value when the key name looks secret", () => {
    expect(isSensitiveValue("DATABASE_PASSWORD", "hunter2")).toBe(true);
    expect(isSensitiveValue("API_KEY", "local-dev")).toBe(true);
  });

  it("ignores an empty value", () => {
    expect(isSensitiveValue("API_KEY", "")).toBe(false);
  });

  it("detects placeholders", () => {
    expect(isPlaceholder("changeme")).toBe(true);
    expect(isPlaceholder("real-value")).toBe(false);
  });
});
