# envpulse

> **Your `.env` files are lying to you. envpulse finds out in one command.**

`envpulse` is a zero-dependency CLI that cross-checks your `.env` files against the variables your source code actually reads. It reports **missing**, **unused**, **drifting**, **duplicated**, and **leaked** values — including secrets committed by accident into `.env.example` — and refuses to stay quiet about a line that is not a `KEY=value` assignment at all.

[![CI](https://github.com/kesheC/envpulse/actions/workflows/ci.yml/badge.svg)](https://github.com/kesheC/envpulse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kesheC/envpulse?color=blue)](https://github.com/kesheC/envpulse/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-informational.svg)](package.json)

**Zero runtime dependencies.** Node.js standard library only — nothing to audit, nothing to pin, nothing that breaks on a Tuesday. The published package is 45 KB packed / 136 KB unpacked, 25 files.

---

## The problem

Every team has a `.env.example` that drifted from `.env`, and a `.env` that drifted from the code. The failure modes are all silent:

- Someone adds `process.env.STRIPE_WEBHOOK_SECRET` to the code and never documents it. Production crashes at 2 AM on `undefined`.
- Someone deletes a feature but leaves `LEGACY_FLAG` in `.env.example` forever. New hires copy stale configs.
- Someone pastes a **real** `sk_live_...` key into `.env.example` "just to show the format" and commits it.
- `PORT=` is defined twice in `.env`; the last line silently wins, and the first line is a lie.

Linters don't check this. `dotenv` doesn't check this. Reviewers miss it in a 400-line diff. `envpulse` checks it in well under a second: five consecutive runs of the fixture below measured 264–351 ms wall clock, Node startup included.

## Install

`envpulse` is **not published to the npm registry.** The name is still free; this
project just has no publishing credentials yet. Every release ships a
ready-to-install tarball instead:

```bash
# global install, straight from the latest release
npm install -g https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz
envpulse --version
```

Every release publishes the same tarball under a stable name (`envpulse.tgz`) alongside an
`envpulse.tgz.sha256` checksum. To verify the download before running it:

```bash
curl -sLO https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz
curl -sLO https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz.sha256
sha256sum -c envpulse.tgz.sha256          # envpulse.tgz: OK
npm install -g ./envpulse.tgz
```

On macOS use `shasum -a 256 -c envpulse.tgz.sha256` — there is no `sha256sum` by default.

The tarball ships `dist/`, `README.md` and `LICENSE`, and nothing else: no `src/`,
no tests, and no `.js.map` files. A sourcemap in a package that publishes no
sources only points at something the reader can never open, so the published build
turns them off — `tsconfig.build.json` keeps that honest and `tests/package.test.ts`
asserts it.

```bash
# or as a project dev dependency
npm install -D https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz
npx envpulse check
```

From a checkout, if you prefer to build it yourself:

```bash
git clone https://github.com/kesheC/envpulse.git
cd envpulse
npm ci && npm run build && npm link
```

Requires Node.js >= 20.11. No `postinstall`, no native modules, no network access at runtime.

> Installing straight from the git URL (`npm i -g git+https://github.com/...`) does
> **not** work: the checkout has no build output and a global install skips
> `devDependencies`, so there is no `tsc` to build it with. Use the tarball above.

## Quick start

```bash
# 1. Audit the current repository
envpulse check

# 2. Machine-readable output for CI
envpulse check --json

# 3. Compare two env files without ever printing secrets
envpulse diff .env .env.example

# 4. Fill the keys your code needs into .env
envpulse sync --from .env.example --to .env --dry-run

# 5. Paste a config into a ticket, with values masked
envpulse mask < .env
```

## Usage

### `envpulse check` — the doctor

Cross-checks every `.env*` file in the project against the variables that the source code actually reads.

| Level | Severity | Meaning |
| --- | --- | --- |
| `MISSING` | **high** | The code reads it, but the template doesn't declare it. |
| `UNUSED` | low | The template declares it, but nothing in the scanned source reads it. |
| `DRIFT` | medium | Two env files disagree about which keys exist. |
| `DUPLICATE` | medium | The same key is assigned twice in one file — the last one silently wins. |
| `UNSAFE` | **high** | A value that will reach other people looks like a live secret (see the three cases below). |
| `EMPTY` | low | Declared with no value, so it will be `undefined` at runtime. |
| `INVALID` | medium | A line is not a `KEY=value` assignment, so it is silently ignored — the variable you meant to set does not exist. |

`UNSAFE` has exactly three cases, because "a secret leaked" always means "it can reach someone else":

1. **A real secret in a template file** (`.env.example`, `.env.sample`, `.env.template`) — templates are meant to be committed, so the value is public. Always **high**.
2. **A real secret in a plain `.env` that git tracks** — someone committed it. Always **high**, and the message says so.
3. **A real secret in a plain `.env` that git does not track** — that is what `.env` is *for*. No finding, no noise.

Case 2 is decided by one `git ls-files` call for the whole run. If git is missing or the directory is not a repository, envpulse silently falls back to case 1 only — it never fails because of git.

`INVALID` exists because a swallowed line is indistinguishable from a missing
variable. Write `DATABASE_URL postgres://...` (no `=`) and the key simply does
not exist; without this check the only symptom is a `MISSING` finding pointing
at a line that is right there in front of you.

**An unparseable line is never printed.** It is the one place where a secret has
no structure to mask: a half-pasted key, a connection string with the `=` missing,
a `cat key.pem >> .env` tail. So `check` and `diff` describe such a line instead
of quoting it — line number, length, and whether it looks like key material — and
the text stays out of stdout and out of `--json`. `mask` rewrites the line in
place rather than echoing it back; see [the mask section](#envpulse-mask--env--share-config-safely).

**Why `INVALID` is medium and never reds your build.** Dotenv files in the wild
carry dialect the format never defined — `[section]` headers, `KEY value` lines
copied out of a README, YAML-style `KEY:`, shell fragments pasted from a
deploy script. Some of those a lenient loader actually tolerates; some are real
bugs. A checker cannot tell them apart, and one that failed the build on every
unrecognised line would red half the repositories it touches. Medium keeps the
finding visible in the human report and available to `--json` consumers
(`counts.medium`), while the exit code stays reserved for problems that change
runtime behaviour. If you want it to gate your CI anyway, gate on the JSON:

```bash
# fail the build when a line was silently swallowed, without making INVALID high
envpulse check --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).counts.medium>0?1:0))'
```

The block below is a real run of that same situation — the `=` is missing on line 2
of `.env`, so the variable silently vanishes:

```text
$ envpulse check --cwd /tmp/noequals
envpulse check  (v0.1.8)
cwd: <scratch>/noequals

env files
      env  .env  2 keys
  example  .env.example  3 keys

scanned 1 source file(s), 3 variable(s) read by code

DRIFT (1)
  [MED] DATABASE_URL
         present in .env.example but not in .env
         in .env.example, .env

INVALID (1)
  [MED] line 2  .env:2
         not a valid KEY=value assignment - it is ignored, so any variable on this line is missing (maybe a missing "="?)


0 high, 2 medium, 0 low  -> exit 0
```

> The demo fixture is **generated, not committed**: run `npm run demo:fixtures`
> first. It writes `examples/demo-app/.env`, which `.gitignore` excludes, so the
> demo exercises UNSAFE case 3 (an untracked local `.env`) instead of case 2. A
> tool that catches secrets in tracked `.env` files has no business shipping one,
> even a harmless one.

Exit code: `0` when no high-severity finding exists, `1` when at least one does, `2` on bad usage. Drop it straight into CI:

```yaml
- run: envpulse check
```

Real output, run against the `examples/demo-app` fixture in this repository
(after `npm run demo:fixtures`). The working directory is printed as `<repo>/...`
here; your own machine prints its real path and nothing else differs:

```text
$ envpulse check --cwd examples/demo-app
envpulse check  (v0.1.8)
cwd: <repo>/examples/demo-app

env files
      env  .env  5 keys  1 duplicate
  example  .env.example  6 keys

scanned 3 source file(s), 7 variable(s) read by code

MISSING (3)
  [HIGH] DEBUG_VERBOSE  .env.example
         read by code but missing from .env.example
         at src/server.ts:6
  [HIGH] DEPLOY_TARGET  .env.example
         read by code but missing from .env.example
         at scripts/deploy.sh:3
         at tools/healthcheck.py:4
  [HIGH] HEALTHCHECK_TIMEOUT  .env.example
         read by code but missing from .env.example
         at tools/healthcheck.py:5

DRIFT (3)
  [MED] DEBUG_VERBOSE
         present in .env but not in .env.example
         in .env, .env.example
  [MED] FEATURE_BETA
         present in .env.example but not in .env
         in .env.example, .env
  [MED] UNUSED_LEGACY_FLAG
         present in .env.example but not in .env
         in .env.example, .env

DUPLICATE (1)
  [MED] PORT  .env:2
         defined 2 times (lines 2, 7) - the last one wins

UNUSED (2)
  [LOW] FEATURE_BETA  .env.example
         declared in .env.example but never read by scanned source
  [LOW] UNUSED_LEGACY_FLAG  .env.example
         declared in .env.example but never read by scanned source


3 high, 4 medium, 2 low  -> exit 1
```

The leak detector, run against `examples/leaky`:

```text
$ envpulse check --cwd examples/leaky
UNSAFE (4)
  [HIGH] AWS_ACCESS_KEY_ID  .env.example:2
         looks like a real secret (AWS access key id) committed in a template file
  [HIGH] DATABASE_URL  .env.example:5
         looks like a real secret (Database URL with an inline password) committed in a template file
  [HIGH] GITHUB_TOKEN  .env.example:4
         looks like a real secret (GitHub personal access token) committed in a template file
  [HIGH] STRIPE_SECRET_KEY  .env.example:3
         looks like a real secret (Stripe live secret key) committed in a template file

4 high, 0 medium, 0 low  -> exit 1
```

That fixture is **generated, not committed** — run `npm run demo:fixtures` first:

```bash
npm run demo:fixtures   # writes examples/demo-app/.env and examples/leaky/.env.example
envpulse check --cwd examples/leaky
```

The values are assembled from fragments at runtime instead of being stored as
literals. A secret scanner should not ship a file full of things that look like
real credentials: GitHub push protection rejects such a push outright, and a tool
whose test suite contains plausible-looking keys is making the exact mistake it
exists to catch.

The fixture above is not a git repository, so `.env.example` is judged by case 1. Copy a real secret into a `.env` that `git ls-files` reports, and the same run turns it into `looks like a real secret (...) in a file tracked by git` — that is the leak worth blocking. An ignored local `.env` stays silent.

### `envpulse diff <a> <b>` — compare without leaking

Values are masked by default. `diff` exits `1` when the files differ (same convention as GNU `diff`).

```text
$ envpulse diff .env .env.example
envpulse diff  (v0.1.8)
A: .env (5 keys)
B: .env.example (6 keys)

only in A (1)
  - DEBUG_VERBOSE

only in B (2)
  + FEATURE_BETA
  + UNUSED_LEGACY_FLAG

changed values (4)
  ~ DATABASE_URL
      A: po****ev
      B: po****mo
  ~ LOG_LEVEL
      A: ****
      B: ****
  ~ PORT
      A: ****
      B: ****
  ~ STRIPE_SECRET_KEY
      A: sk****C9
      B: sk****me

0 key(s) identical
```

Add `--reveal` when you really need the plaintext — it is never the default.

A rotated key is a change even when the header is byte-identical, so `diff`
digests the lines *underneath* a `-----BEGIN ... PRIVATE KEY-----` header
(the body cannot fit in an env value) and compares that too. The digest is a
truncated SHA-256, so "identical" for a PEM block is a 64-bit judgement rather
than a byte comparison — deliberate for an advisory CLI, and the block's bytes
are never loaded for comparison in the first place. `--reveal` still never
prints a PEM block, and the count below reports key material lines only
(the `-----END ...-----` marker is a delimiter, not a secret):

```text
$ envpulse diff a.env b.env --reveal
envpulse diff  (v0.1.8)
A: a.env (1 keys)
B: b.env (1 keys)

changed values (1)
  ~ PRIVATE_KEY
      A: --****--
      B: --****--
      + 2 more lines of key material

0 key(s) identical
```

And a file whose stray lines differ is not identical either — those lines are
not keys, but they are content:

```text
$ envpulse diff junk.env junk2.env
envpulse diff  (v0.1.8)
A: junk.env (2 keys)
B: junk2.env (2 keys)

not a KEY=value assignment in A (1)
  - line 2: 19 bytes, omitted

2 key(s) identical
```

### `envpulse sync --from <template> --to <target>` — fix the drift

Adds every template key that is missing from the target, **in template order**, anchored to the next template key that already exists. Existing values, comments, ordering and line endings are preserved byte for byte. Nothing is ever deleted.

```text
$ cp .env .env.sync-demo
$ envpulse sync --from .env.example --to .env.sync-demo --dry-run
would add 2 key(s) to .env.sync-demo
  + FEATURE_BETA
  + UNUSED_LEGACY_FLAG
dry run - nothing written
1 key(s) in .env.sync-demo are not in the template (kept): DEBUG_VERBOSE
```

Keys present in the target but absent from the template are reported as stale and **kept** — deletion is your decision, not the tool's.

### `envpulse mask < .env` — share config safely

```text
$ envpulse mask < .env
# Local developer overrides
PORT=8080
DATABASE_URL=postgres://localhost:5432/demo_dev
STRIPE_SECRET_KEY=sk****C9
LOG_LEVEL=debug
DEBUG_VERBOSE=true
PORT=9090
```

Masking is driven by the **value** first and the **key name** second, so `LOG_LEVEL=debug` and a credential-free `DATABASE_URL` stay readable while `STRIPE_SECRET_KEY` is masked. A key called `DB` whose value actually contains a password is masked too — the value decides, not the name. Pass `--all` to mask everything.

A PEM block cannot live in a single env value, which is exactly how it leaks: the assignment line gets masked and the key material on the following lines used to be printed in full. `mask` swallows the whole block through its `-----END ...-----` line:

```text
$ printf 'PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----\nDEBUG=true\n' > /tmp/pem.env
$ envpulse mask < /tmp/pem.env
PRIVATE_KEY=--****--
MI****dy
--****--
DEBUG=true
```

That holds for the shapes people actually produce, not just the tidy one:

- **`cat key.pem >> .env`** leaves `PRIVATE_KEY=` empty on one line and a bare
  `-----BEGIN ...-----` on the next. The block is still recognised and masked.
- **A blank line** somewhere inside the body does not end it. (It used to.)
- **Lowercase labels** — `-----begin rsa private key-----` — are valid RFC 7468
  and are handled like any other block.
- **A base64 line that ends in `=`** (about a quarter of real 2048-bit RSA keys)
  is body, not a `KEY=` assignment.

```text
$ printf 'PRIVATE_KEY=\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----\nDEBUG=true\n' > /tmp/pem2.env
$ envpulse mask < /tmp/pem2.env
PRIVATE_KEY=
--****--
MI****dy
--****--
DEBUG=true
```

`mask` also fixes the line it cannot parse. The usual cause is a missing `=`, and
a mask that echoes a URL full of credentials back at you is worse than no mask at
all, because you trust it enough to paste the output into an issue:

```text
$ cat typo.env
GOOD=1
DATABASE_URL postgres://admin:hunter2hunter2@db.internal:5432/prod
$ envpulse mask typo.env
GOOD=1
DATABASE_URL po****od
```

`mask` reads stdin, or a single file argument, so `envpulse mask .env` does what
it looks like it does. A file that cannot be read is an error (exit 2), not a
silent no-op.

`diff` shares the same predicate: a PEM header is masked even with `--reveal`, because the header is the block opener, not a value you can retype.

### `envpulse init --from-code` — bootstrap a template

Generates a `.env.example` skeleton from every variable the code reads, grouped by the directory that reads it:

```text
$ envpulse init --from-code --dry-run
# Generated by envpulse init --from-code
# Every key below is read somewhere in this repository.
# Fill in a real value, or leave it blank to make it optional.

# --- scripts ---
DEPLOY_TARGET=
LOG_LEVEL=

# --- src ---
DATABASE_URL=
DEBUG_VERBOSE=
PORT=
STRIPE_SECRET_KEY=

# --- tools ---
HEALTHCHECK_TIMEOUT=
```

The real command refuses to overwrite an existing file unless you pass `--force`.

### JSON output

Every command accepts `--json` for CI and dashboards. This is a real run (140 lines) with the middle of `findings` collapsed to `...` for readability — every field shown is exactly as printed:

```text
$ envpulse check --cwd examples/demo-app --json
{
  "tool": "envpulse",
  "version": "0.1.8",
  "command": "check",
  "cwd": ".../examples/demo-app",
  "envFiles": [
    {
      "path": ".env",
      "kind": "env",
      "keys": 5,
      "duplicates": [
        "PORT"
      ]
    },
    {
      "path": ".env.example",
      "kind": "example",
      "keys": 6,
      "duplicates": []
    }
  ],
  "sourceFiles": 3,
  "variablesRead": [
    "DATABASE_URL",
    "DEBUG_VERBOSE",
    "DEPLOY_TARGET",
    "HEALTHCHECK_TIMEOUT",
    "LOG_LEVEL",
    "PORT",
    "STRIPE_SECRET_KEY"
  ],
  "findings": [
    {
      "code": "MISSING",
      "severity": "high",
      "key": "DEBUG_VERBOSE",
      "message": "read by code but missing from .env.example",
      "file": ".env.example",
      "hits": [
        {
          "key": "DEBUG_VERBOSE",
          "file": "src/server.ts",
          "line": 6
        }
      ]
    }
  ],
  "counts": {
    "high": 3,
    "medium": 4,
    "low": 2
  },
  "notes": [],
  "exitCode": 1
}
```

**What happens when there is no `.env` at all** — the honest answer. In a scratch directory that contains one source file and no env file:

```text
$ mkdir -p /tmp/nodotenv/src && echo 'const api = process.env.API_URL;' > /tmp/nodotenv/src/index.js
$ cd /tmp/nodotenv && envpulse check
envpulse check  (v0.1.8)
cwd: <scratch>/nodotenv

no .env files found - nothing to cross-check.

scanned 1 source file(s), 1 variable(s) read by code

no problems found
note: no template env file found, so MISSING cannot be reported. Create .env.example (try `envpulse init --from-code`).

0 problems
```

envpulse does not invent problems to look busy. With no template there is nothing to compare against, so it says so and exits `0`. In a completely empty directory:

```text
$ envpulse check
envpulse check  (v0.1.8)
cwd: <scratch>/empty

no .env files found - nothing to cross-check.

scanned 0 source file(s), 0 variable(s) read by code

no problems found

0 problems
```

And when there is a `.env` but no template, it uses the `.env` itself as the reference and says so — note the **low**-severity `UNUSED` (it never fails a build) and the trailing `exit 0`:

```text
$ cd /tmp/dotenv-only && envpulse check
envpulse check  (v0.1.8)
cwd: <scratch>/dotenv-only

env files
      env  .env  2 keys

scanned 1 source file(s), 1 variable(s) read by code

UNUSED (1)
  [LOW] DEBUG  .env
         declared in .env but never read by scanned source

note: template .env is not an example file - it may contain real values.

0 high, 0 medium, 1 low  -> exit 0
```

## How it works

1. **Parse** (`src/parser.ts`). A real dotenv parser, not a regex split: `export` prefixes, single/double/unquoted values, inline `#` comments (respecting quotes), `\n` / `\t` / `\"` escapes, multi-line double-quoted values, UTF-8 BOM, and CRLF/LF detection. Unparseable lines are collected into `EnvFile.invalid`, surfaced as `INVALID` findings and shown in `diff`, never silently dropped — and never quoted either: the record keeps a length, a digest and a "looks like key material" flag instead of the text. A value that opens a PEM block swallows its body lines and keeps a SHA-256 digest of them, which is what lets `diff` see a rotated key whose header did not change.
2. **Scan** (`src/scan.ts`). Walks the tree deterministically (sorted), skipping `node_modules`, `.git`, `dist`, `build`, `venv`, and friends. Files are dispatched by extension:
   - `.js .mjs .cjs .ts .mts .cts .jsx .tsx` → `process.env.NAME`, `process.env["NAME"]`, `import.meta.env.NAME`, `Deno.env.get("NAME")`
   - `.py` → `os.environ["NAME"]`, `os.environ.get("NAME")`, `os.getenv("NAME")`
   - `.sh .bash .zsh` → `$NAME`, `${NAME:-default}` (shell builtins like `$PATH` are skipped)
   Every hit keeps its 1-based line number, so findings point at real code.
3. **Evaluate** (`src/checker.ts` + `src/rules.ts`). Compares the template, the other env files, and the scan result. Secret detection combines known-format regexes (Stripe, AWS, GitHub, Slack, OpenAI, PEM private keys, JWT, DB URLs with passwords) with a Shannon-entropy heuristic that requires >= 32 chars, >= 3 character classes, and >= 4 bits/char — so `sk_test_replace_me` passes and `sk_live_51H8xQ...` does not.
4. **Report** (`src/report.ts`). One human renderer and one JSON renderer over the same data model. Colors are opt-out via `--no-color` or `NO_COLOR`.
5. **Fix** (`src/fix.ts`). Edits are line-based and minimal: `sync` splices new lines into the original text instead of re-serializing the file, which is why comments, quoting style and CRLF survive untouched.

## API

The CLI is a thin shell over an exported library — no `process.exit`, no argv parsing:

```ts
import { checkProject, diffFiles, syncEnvFiles, parseEnvFile, scanSource } from "envpulse";

const report = checkProject({ cwd: process.cwd() });
console.log(report.counts.high, report.findings);

const diff = diffFiles(".env", ".env.example", ".env", ".env.example", { reveal: false });

const sync = syncEnvFiles({ from: ".env.example", to: ".env", dryRun: true });

const file = parseEnvFile(".env");        // entries, duplicates, quote, line numbers
const scan = scanSource(process.cwd());   // Map<key, {file, line}[]>
```

Types shipped in `dist/index.d.ts`: `EnvFile`, `EnvEntry`, `Finding`, `CheckReport`, `DiffReport`, `ScanResult`, and friends.

## FAQ

**Does it upload my secrets anywhere?**  No. It never opens a socket. There is no telemetry, no registry call, no update check. Read `src/` — it is ~2,400 lines and imports only `node:fs`, `node:path`, `node:process`, `node:url`, `node:crypto` (to digest PEM bodies) and `node:child_process` (solely to run `git ls-files`, which reads your local index and touches no network).

**Will it flag a fake key in my test suite?**  Usually not: placeholders (`changeme`, `xxxx`, `your-key-here`, `sk_test_...`, `AKIAIOSFODNN7EXAMPLE`) are explicitly ignored. If a fixture still trips it, `--no-unsafe` disables the rule.

**My local `.env` really does hold live keys. Will that fail my build?**  No — only if git tracks it. An ignored `.env` produces no `UNSAFE` finding at all (case 3). The moment `git ls-files` reports it, the same value becomes `high`, because now it is in your history and on the remote.

**I passed `--reveal` to `check` and it exited 2. Is that a bug?**  No — `check`
never prints a value, so there is nothing for `--reveal` to do, and a flag that
does nothing looks exactly like a flag that worked. Each command declares the
options it reads; anything else is a usage error that names the commands that do
read it: `envpulse: `check` does not read --reveal; it applies to diff, mask`.
`--help` and `--version` work everywhere.
**Why not just use `dotenv-linter`?**  `dotenv-linter` checks style inside one file. envpulse checks the *relationship* between your env files and your source code — which is where real outages come from.

**It flagged a key my framework reads implicitly (Next.js, Vite, `NODE_ENV`).**  Declaring it in the template is the honest fix, since the framework does read it. `UNUSED` is low severity and never fails the build, so a false positive costs you nothing but a line of noise.

**My build passes but a variable is `undefined` in production. Can envpulse catch that?**  Only if the file says so. A line like `DATABASE_URL postgres://...` (missing `=`) parses as nothing, so the key never exists — run the same command and you get an `INVALID` finding on that exact line, plus whatever falls out of it. Set `--json` and grep for the code.

**What if I typo `--cwd`?**  It exits `2` with `--cwd ... does not exist` on stderr. A wrong path must never look like a clean bill of health.

**Does `sync` delete keys?**  Never. Stale keys are reported and kept. `sync` only inserts lines.

**Monorepo support?**  `check --cwd packages/api` works today. A `--workspace` flag is on the roadmap.

## Security and changes

Found a vulnerability? Please do not open a public issue — [SECURITY.md](SECURITY.md)
explains the private reporting channel and what to include. Every release is written
up in [CHANGELOG.md](CHANGELOG.md).

## License

MIT © 2026 kesheC. See [LICENSE](LICENSE).

---

## 中文

> **你的 `.env` 文件在骗你。envpulse 用一条命令把它抓出来。**

`envpulse` 是一个**零运行时依赖**的命令行工具（只用 Node.js 标准库），把 `.env` 文件和源码里真正读取的变量做交叉核对，报告 **缺失（MISSING）**、**未被使用（UNUSED）**、**文件间漂移（DRIFT）**、**重复定义（DUPLICATE）** 和 **真实密钥泄漏（UNSAFE）**；写成 `KEY value`（少一个等号）的行也不再被静默吞掉，而是报 **非法行（INVALID）**。

下面九个小节与上方英文的九个 `##` 小节一一对应、顺序相同、信息等价，命令、选项、退出码、版本号和包体积数字都与英文部分一致。可复制的命令码块只保留在英文小节里；这里写成行内命令，不再重复贴一份迟早会走样的副本。

### 问题所在（The problem）

每个团队的 `.env.example` 都会和 `.env` 漂移，`.env` 又会和代码漂移，而这些错误**全都是静默的**：

- 有人在代码里加了 `process.env.STRIPE_WEBHOOK_SECRET`，却忘了写进模板。生产环境凌晨两点因为 `undefined` 崩了。
- 功能下线了，`LEGACY_FLAG` 却永远留在 `.env.example` 里。新人照着过期配置复制。
- 有人为了「演示格式」，把真实的 `sk_live_...` 密钥贴进 `.env.example` 并提交了。
- `.env` 里 `PORT=` 定义了两次，最后一行静默生效，第一行是假的。

ESLint 不管这些，`dotenv` 不管这些，人工 review 在 400 行 diff 里也看不出来。envpulse 连 Node 启动在内跑完一次不到半秒：对下面那个 fixture 连跑 5 次，实测 264–351 毫秒。

### 安装（Install）

`envpulse` **没有发布到 npm registry**。这个名字目前还是空的，只是本项目还没有发布凭据，所以每个 release 都附带可直接安装的 tarball：

- 全局安装最新 release 的 tarball：`npm install -g https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz`，然后 `envpulse --version`。
- 先校验再装：下载固定名字的 `envpulse.tgz` 和 `envpulse.tgz.sha256`，跑 `sha256sum -c envpulse.tgz.sha256` 看到 `envpulse.tgz: OK`，再 `npm install -g ./envpulse.tgz`。macOS 上没有 `sha256sum`，用 `shasum -a 256 -c envpulse.tgz.sha256`。
- 或者装成项目的 devDependency：`npm install -D https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz`，然后 `npx envpulse check`。
- 想自己编译就从源码来：`git clone https://github.com/kesheC/envpulse.git`，`cd envpulse`，`npm ci && npm run build && npm link`。

tarball 里只有 `dist/`、`README.md` 和 `LICENSE`：没有 `src/`、没有测试、也没有 `.js.map`。不发源码的包里带 sourcemap 只是指向一个读者永远打不开的文件，所以发布构建关掉了它，由 `tsconfig.build.json` 守着，并有 `tests/package.test.ts` 断言。

**不要**直接用 git URL 装（`npm i -g git+https://github.com/...`）：checkout 里没有构建产物，而全局安装会跳过 `devDependencies`，也就没有 `tsc` 能把它编出来。

需要 Node.js >= 20.11。没有 `postinstall`，没有原生模块，运行时**不联网**。

### 快速开始（Quick start）

五条命令就是全部日常用法，依次是：`envpulse check` 体检当前仓库；`envpulse check --json` 拿到给 CI 用的 JSON；`envpulse diff .env .env.example` 对比两个文件（默认打码）；`envpulse sync --from .env.example --to .env --dry-run` 先看会往 `.env` 补哪些键；`envpulse mask < .env` 把配置贴进工单也不泄露。

### 用法（Usage）

| 命令 | 作用 |
| --- | --- |
| `check` | 交叉核对项目里每个 `.env*` 文件和源码实际读取的变量，报告 MISSING / UNUSED / DRIFT / DUPLICATE / UNSAFE / EMPTY。 |
| `diff <a> <b>` | 逐键对比两个 env 文件：只在 A、只在 B、值不同三类；**默认对值打码**。 |
| `sync --from --to` | 把模板里有、目标文件里没有的键**按模板顺序插入**；绝不删除、绝不改动已有行。 |
| `mask` | 从 stdin（或一个文件名参数）读 env 文本，把敏感值打码后输出。 |
| `init --from-code` | 扫描源码，反向生成 `.env.example` 骨架，按目录分组。 |

`check` 的选项：`--cwd <dir>`（默认 `.`）、`--template <file>`（默认自动挑最像例子的那个 env 文件）、`--no-unsafe`（完全跳过密钥检测）、`--no-unused`（跳过 UNUSED 规则）、`--json`、`--no-color`。

`diff <a.env> <b.env>` 的选项：`--reveal`（显示明文值）、`--json`、`--no-color`。

`sync` 的选项：`--from <file>`（默认 `.env.example`）、`--to <file>`（默认 `.env`）、`--dry-run`（只打印不写盘）、`--json`、`--no-color`。它按模板顺序补键，复用目标文件已有的引号风格和注释布局，永不删除。

`mask [file]` 的选项：`--all`（不只敏感值，全部打码）、`--no-key-names`（只看值，忽略像密钥的键名）、`--reveal`（关掉打码，恒等变换，方便做 diff）。

`init` 的选项：`--from-code`（扫描源码，目前唯一的模式）、`--cwd <dir>`（默认 `.`）、`--out <file>`（默认 `.env.example`）、`--force`（覆盖已存在的输出文件）、`--dry-run`（只打印骨架）、`--json`。

全局选项：`-h, --help`、`-v, --version`、`--json`（check / diff / sync / init）、`--reveal`（diff / mask）、`--no-color`；环境变量 `NO_COLOR` 一样能关掉 ANSI 颜色。

退出码：`0` 没有高危问题；`1` 至少一个高危问题（`diff` 发现差异也算）；`2` 用法错误或输入读不了。

几条值得单独说的设计（英文那节里散在 `check` 的说明和 FAQ 中）：

- **`UNSAFE` 分三种情况**：真密钥在模板文件里（`.env.example` / `.env.sample` / `.env.template`）一定是 `high`，模板本来就是给人提交的；真密钥在**被 git 跟踪**的普通 `.env` 里也是 `high`，报错会写明 `in a file tracked by git`；真密钥在**没被跟踪**的 `.env` 里不报，那正是 `.env` 的用途。
- **打码看值、其次看名字**：`mask` 先判断值本身像不像密钥（带密码的连接串、PEM 私钥、高熵串），再看键名里有没有 `SECRET` / `TOKEN` / `PASSWORD`。
- **PEM 整块打码，也整块比对**：私钥塞不进一行 env 值，赋值行被打码、后面几行的密钥正文却被原样打印——这是最常见的泄漏方式，所以 `mask` 会一路吞到 `-----END ...-----`；`diff` 复用同一套判断，即使加 `--reveal` 也不显示 PEM 头，并给正文算一个摘要参与比对，所以只换正文、头没变的密钥轮换也能被发现。
- **`INVALID` 是 medium，不单独把构建搞红**：真实世界里的 dotenv 塞满了格式从没定义过的东西，宽松的加载器能忍、严格的不能，工具分不清。它在人类可读报告和 `--json` 的 `counts.medium` 里都能被看见，而退出码继续留给真正改变运行时行为的问题。
- **看不懂的行绝不回显**：一行不是 `KEY=value` 时，它恰恰最可能藏密钥，所以只描述行号、长度和像不像密钥材料，原文既不进 stdout 也不进 `--json`。
- **路径写错不是绿灯**：`--cwd` 指向的目录不存在就退出 `2`，而不是打印「没找到 .env」然后退出 `0`。
- **`sync` 只插入、不重写**：直接对原始文本做行拼接，注释、引号风格、CRLF 换行全部原样保留。
- **占位符不算泄漏**：`changeme`、`xxxx`、`your-key-here`、`sk_test_...`、`AKIAIOSFODNN7EXAMPLE` 都会被放过。
- **零依赖是刻意的**：安全工具自己成为供应链风险就很荒谬。已发布的整包是 45 KB packed / 136 KB unpacked、25 个文件。
- **不臆造问题**：仓库里没有可比的模板时，它明确说「无从比对」并退出 `0`，而不是假装发现了问题。

真实运行输出见英文部分 —— 每一个代码块都是在 `examples/` 目录和本仓库上实际跑出来的，不是编的。要复现这些 demo，先跑 `npm run demo:fixtures`：它会生成 `examples/demo-app/.env` 和 `examples/leaky/.env.example`，两个都被 `.gitignore` 排除。**故意不提交**：一个专门抓「被提交的 .env」的工具，自己的仓库里不该躺着一个被跟踪的 `.env`，哪怕它无毒。

### 工作原理（How it works）

1. **解析**（`src/parser.ts`）。是真正的 dotenv 解析器，不是正则切分：`export` 前缀、单引号 / 双引号 / 不带引号的值、受引号保护的行内 `#` 注释、`\n` / `\t` / `\"` 转义、跨行双引号值、UTF-8 BOM、CRLF 与 LF 自适应。解析不了的行收进 `EnvFile.invalid`，变成 `INVALID` 报告并出现在 `diff` 里，绝不静默丢弃 —— 也绝不被回显：记录里存的是长度、摘要和一个「像不像密钥材料」的标志，而不是原文。一个值如果打开了 PEM 块，它会把正文行一并吞掉并保留正文的 SHA-256 摘要，这正是 `diff` 能发现「头没变、正文换了的密钥轮换」的原因。
2. **扫描**（`src/scan.ts`）。确定性地（按名字排序）遍历目录，跳过 `node_modules`、`.git`、`dist`、`build`、`venv` 等，按扩展名分派：`.js .mjs .cjs .ts .mts .cts .jsx .tsx` 认 `process.env.NAME`、`process.env["NAME"]`、`import.meta.env.NAME`、`Deno.env.get("NAME")`；`.py` 认 `os.environ[...]`、`os.environ.get(...)`、`os.getenv(...)`；`.sh .bash .zsh` 认 `$NAME`、`${NAME:-default}`（`$PATH` 这类 shell 内建会跳过）。每个命中都带从 1 开始的行号，所以报告能指向真实代码。
3. **判定**（`src/checker.ts` + `src/rules.ts`）。把模板、其它 env 文件、扫描结果放在一起比。密钥检测同时用已知格式正则（Stripe、AWS、GitHub、Slack、OpenAI、PEM 私钥、JWT、带密码的数据库 URL）和香农熵启发式：长度 >= 32 字符、至少 3 种字符类、熵 >= 4 bits/char —— 所以 `sk_test_replace_me` 能过，`sk_live_51H8xQ...` 过不了。
4. **报告**（`src/report.ts`）。同一份数据模型上跑两个渲染器：一个给人看，一个出 JSON。颜色可以用 `--no-color` 或 `NO_COLOR` 关掉。
5. **修复**（`src/fix.ts`）。改动按行做、尽量小：`sync` 是把新行拼进原文，而不是把文件重新序列化，所以注释、引号风格、CRLF 全都原样活下来。

### API

CLI 只是薄壳，核心能力都通过 `dist/index.js` 导出，无 `process.exit`、无 argv 解析：`checkProject({ cwd })` 返回整个体检报告（`report.counts.high`、`report.findings`）；`diffFiles(".env", ".env.example", ".env", ".env.example", { reveal: false })` 返回两个文件的差异；`syncEnvFiles({ from, to, dryRun: true })` 返回会插入哪些键；`parseEnvFile(".env")` 给出 entries、duplicates、引号风格和行号；`scanSource(process.cwd())` 给出每个 key 被哪些 `{file, line}` 读取。

`dist/index.d.ts` 里还导出这些类型：`EnvFile`、`EnvEntry`、`Finding`、`CheckReport`、`DiffReport`、`ScanResult` 等。

### 常见问题（FAQ）

**它会把我的密钥上传吗？** 不会。它从不打开套接字：没有遥测、没有 registry 请求、没有更新检查。去读 `src/` —— 约 2,400 行，只 import 了 `node:fs`、`node:path`、`node:process`、`node:url`、`node:crypto`（给 PEM 正文算摘要）和 `node:child_process`（只用来跑 `git ls-files`，读本地索引，不碰网络）。

**测试专用假密钥会被误报吗？** 一般不会：占位符（`changeme`、`xxxx`、`your-key-here`、`sk_test_...`、`AKIAIOSFODNN7EXAMPLE`）被显式放过。万一某个 fixture 还是踩线，`--no-unsafe` 能关掉整条规则。

**我本机 `.env` 里就是真密钥，会把构建搞红吗？** 不会 —— 只有 git 跟踪它时才会。被忽略的 `.env` 完全不产生 `UNSAFE`；一旦 `git ls-files` 报了它，同一个值立刻变 `high`，因为这时它已经进了你的历史和远端。

**我给 `check` 传了 `--reveal`，退出码 2，这是 bug 吗？** 不是 —— `check` 从不打印任何值，`--reveal` 无事可做，而一个什么都不做的开关看起来和「生效了」一模一样。每个命令都声明自己真正读取的选项，其余一律是用法错误，并点名哪些命令会读它：`envpulse: `check` does not read --reveal; it applies to diff, mask`。`--help` 和 `--version` 在所有命令上都可用。
**为什么不直接用 `dotenv-linter`？** `dotenv-linter` 检查单个文件的风格；envpulse 检查的是你的 env 文件和源码之间的**关系** —— 真实故障正是从那来的。

**它给我框架隐式读取的变量（Next.js、Vite、`NODE_ENV`）报了 UNUSED。** 写进模板才是诚实的做法，因为框架确实会读它。`UNUSED` 是 low 级、从不把构建搞红，误报的代价只是一行噪音。

**构建过了，但线上某个变量是 `undefined`，envpulse 能发现吗？** 只有当文件本身就写错了才行。像 `DATABASE_URL postgres://...`（少了 `=`）这样的行什么都解析不出来，那个键根本不存在 —— 跑同一条命令你会拿到指向该行的 `INVALID`，以及由它连带出来的问题。加 `--json` 后 grep 对应的 code 即可。

**`--cwd` 打错字会怎样？** 退出 `2`，stderr 上是 `--cwd ... does not exist`。写错路径绝不能看起来像「一切正常」。

**`sync` 会删键吗？** 永远不会。过期键只被报告、被保留；`sync` 只做插入。

**支持 monorepo 吗？** `check --cwd packages/api` 现在就能用；`--workspace` 在路线图里。

### 安全与变更（Security and changes）

发现安全问题请**不要**开公开 issue —— [SECURITY.md](SECURITY.md) 说明了私密上报渠道以及需要提供哪些信息。每个版本的改动都记在 [CHANGELOG.md](CHANGELOG.md)。

### 许可证（License）

MIT © 2026 kesheC。详见 [LICENSE](LICENSE)。
