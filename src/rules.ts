import { shannonEntropy } from "./util.js";

export interface UnsafeRule {
  id: string;
  /** Human readable description used in the report. */
  description: string;
  test: (value: string) => boolean;
}

const PLACEHOLDER_RE = /^(x{3,}|\.{3,}|<.*>|your[_-].*|changeme|change[_-]?me|todo|placeholder|example|sample|dummy|fake|test|none|null|true|false|\$\{.*\})$/i;

/** Values that look like real credentials. Order matters: first match wins. */
export const UNSAFE_RULES: UnsafeRule[] = [
  { id: "stripe-live", description: "Stripe live secret key", test: (v) => /^(sk|rk)_live_[A-Za-z0-9]{10,}/.test(v) },
  { id: "stripe-test-long", description: "Stripe secret key with a real-looking body", test: (v) => /^(sk|rk)_(test|live)_[A-Za-z0-9]{20,}/.test(v) },
  { id: "aws-akid", description: "AWS access key id", test: (v) => /^(AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|A3T)[A-Z0-9]{16}$/.test(v) },
  { id: "github-pat", description: "GitHub personal access token", test: (v) => /^gh[pousr]_[A-Za-z0-9]{36,}$/.test(v) },
  { id: "github-pat-fine", description: "GitHub fine grained token", test: (v) => /^github_pat_[A-Za-z0-9_]{50,}$/.test(v) },
  { id: "slack-token", description: "Slack token", test: (v) => /^xox[abprs]-[A-Za-z0-9-]{10,}/.test(v) },
  { id: "google-api-key", description: "Google API key", test: (v) => /^AIza[A-Za-z0-9_-]{35}$/.test(v) },
  { id: "openai-key", description: "OpenAI API key", test: (v) => /^sk-[A-Za-z0-9_-]{32,}$/.test(v) && !/^sk-(test|example|xxx)/i.test(v) },
  { id: "anthropic-key", description: "Anthropic API key", test: (v) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v) },
  { id: "npm-token", description: "npm automation token", test: (v) => /^npm_[A-Za-z0-9]{36}$/.test(v) },
  { id: "private-key", description: "PEM private key", test: (v) => v.includes("-----BEGIN") && /PRIVATE KEY-----/.test(v) },
  { id: "jwt", description: "JSON Web Token", test: (v) => /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(v) },
  { id: "db-url-with-password", description: "Database URL with an inline password", test: (v) => /^(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:/\s]+:[^@\s]{8,}@/.test(v) },
  { id: "high-entropy", description: "High entropy string (likely a generated secret)", test: isHighEntropySecret },
];

/**
 * A generated secret: long, mixed alphabet, no spaces, and not an obvious
 * placeholder. 32 characters with >= 4.0 bits/char entropy is the cut-off that
 * catches real tokens while leaving human-readable sample values alone.
 */
export function isHighEntropySecret(value: string): boolean {
  if (value.length < 32 || value.length > 512) return false;
  if (/\s/.test(value)) return false;
  if (PLACEHOLDER_RE.test(value)) return false;
  if (/^[\d.]+$/.test(value)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !/[A-Z]/.test(value)) return false;
  // A connection string is structured, not random: its entropy comes from the
  // host name and path. Only the credentialed form is a leak, and the dedicated
  // db-url-with-password rule already covers that case.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) && !/\/\/[^/@\s]*:[^/@\s]+@/.test(value)) return false;
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  const hasSymbol = /[^A-Za-z0-9]/.test(value);
  const classes = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
  if (classes < 3) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return shannonEntropy(value) >= 4;
}

/** Return the first matching rule, or null when the value looks harmless. */
export function matchUnsafe(value: string): UnsafeRule | null {
  const trimmed = value.trim();
  if (trimmed === "" || PLACEHOLDER_RE.test(trimmed)) return null;
  for (const rule of UNSAFE_RULES) {
    if (rule.test(trimmed)) return rule;
  }
  return null;
}

/** True when a template value is a placeholder the user still has to fill in. */
export function isPlaceholder(value: string): boolean {
  return value.trim() === "" || PLACEHOLDER_RE.test(value.trim());
}

export interface SensitiveKeyOptions {
  /** Also mask values whose NAME looks secret even when the value looks dull. */
  byKeyName?: boolean;
}

/** Key names that usually carry credentials. */
const SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL|AUTH|SIGNATURE|SALT|CERT)/i;

/**
 * True when a line can continue a PEM block body.
 *
 * A .env cannot hold a real PEM in one value - the key is pasted as a raw
 * multi-line block, so the following lines parse as unassignable text. mask,
 * diff and the parser all need to treat that whole run as one secret, so they
 * share this predicate.
 *
 * Blank lines are body, not a terminator: a pasted key can carry a stray empty
 * line, and stopping there used to push the rest of the base64 straight into
 * the unparseable bucket, where it was printed verbatim. Only a line that
 * starts a *new* assignment ends the block.
 */
export function isPemBodyLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (trimmed.startsWith("#")) return false;
  const assignment = /^[A-Za-z_][A-Za-z0-9_.-]*\s*=/.exec(trimmed);
  if (assignment === null) return true;
  // `abc=` and `abc==` are base64 padding at the end of a key line, not an
  // assignment with an empty value. Roughly a quarter of real 2048-bit RSA keys
  // end with one of those, and treating them as keys made a key line look like
  // a variable name.
  const after = trimmed.slice(assignment[0].length);
  return after === "" || /^=+$/.test(after);
}

/** Marks the first line of a PEM block, either bare or as an env value. */
const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN CERTIFICATE-----/i;

/** True when this line opens a PEM block. */
export function opensPemBlock(line: string): boolean {
  return PEM_BEGIN_RE.test(line);
}

/** True when this line closes a PEM block. */
export function closesPemBlock(line: string): boolean {
  return /-----END [A-Z0-9 ]*PRIVATE KEY-----|-----END CERTIFICATE-----/i.test(line);
}

/** True when a value should never be pasted into a screenshot. */
export function isSensitiveValue(key: string, value: string, options: SensitiveKeyOptions = {}): boolean {
  if (value.trim() === "") return false;
  if (matchUnsafe(value) !== null) return true;
  if (options.byKeyName !== false && SECRET_KEY_RE.test(key)) {
    return !isPlaceholder(value);
  }
  return false;
}
