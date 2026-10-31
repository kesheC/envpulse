# envpulse

> **Your `.env` files are lying to you. envpulse finds out in one command.**

`envpulse` is a zero-dependency CLI that cross-checks your `.env` files against the variables your source code actually reads. It reports **missing**, **unused**, **drifting**, **duplicated**, and **leaked** values — including secrets committed by accident into `.env.example` — and refuses to stay quiet about a line that is not a `KEY=value` assignment at all.

[![CI](https://github.com/kesheC/envpulse/actions/workflows/ci.yml/badge.svg)](https://github.com/kesheC/envpulse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kesheC/envpulse?color=blue)](https://github.com/kesheC/envpulse/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-informational.svg)](package.json)

**Zero runtime dependencies.** Node.js standard library only — nothing to audit, nothing to pin, nothing that breaks on a Tuesday. The published package is 48 KB packed / 180 KB unpacked, 36 files.

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
at a line that is right there in front of you. It is **medium**, so it cannot
turn a build red on its own:

```text
$ envpulse check --cwd /tmp/noequals
envpulse check  (v0.1.6)
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

> One caveat about this repository's own fixture: `examples/demo-app/.env` **is**
> tracked by `git ls-files` (the demo needs a realistic `.env`), so it falls under
> case 2. It survives on a technicality: its value is
> `sk_test_51H8xQ2eZvKYlo2C9`, 25 characters in total and 17 after `sk_test_`,
> while the `stripe-test-long` rule wants 20 body characters and the entropy rule
> wants 32. Lengthen that value and the demo output below gains a `UNSAFE` row
> with a different summary line. That is the intended behaviour, not an oversight
> — the fixture really is a tracked `.env`.

Exit code: `0` when no high-severity finding exists, `1` when at least one does, `2` on bad usage. Drop it straight into CI:

```yaml
- run: envpulse check
```

Real output, run against the `examples/demo-app` fixture in this repository.
The working directory is printed as `<repo>/...` here; your own machine prints its real path and nothing else differs:

```text
$ envpulse check --cwd examples/demo-app
envpulse check  (v0.1.6)
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

That fixture is **generated, not committed** — run `node scripts/make-leaky-fixture.mjs` first:

```bash
node scripts/make-leaky-fixture.mjs   # writes examples/leaky/.env.example (gitignored)
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
envpulse diff  (v0.1.6)
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
(the body cannot fit in an env value) and compares that too. `--reveal` still
never prints a PEM block:

```text
$ envpulse diff a.env b.env --reveal
envpulse diff  (v0.1.6)
A: a.env (1 keys)
B: b.env (1 keys)

changed values (1)
  ~ PRIVATE_KEY
      A: --****--
      B: --****--
      + 2 more line(s) of key material

0 key(s) identical
```

And a file whose stray lines differ is not identical either — those lines are
not keys, but they are content:

```text
$ envpulse diff junk.env junk2.env
envpulse diff  (v0.1.6)
A: junk.env (2 keys)
B: junk2.env (2 keys)

not a KEY=value assignment in A (1)
  - line 2: DIFFERENT JUNK HERE

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

A PEM block cannot live in a single env value, which is exactly how it leaks: the assignment line gets masked and the key material on the following lines used to be printed in full. `mask` now swallows the whole block through its `-----END ...-----` line:

```text
$ printf 'PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----\nDEBUG=true\n' > /tmp/pem.env
$ envpulse mask < /tmp/pem.env
PRIVATE_KEY=--****--
MI****dy
--****--
DEBUG=true
```

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
  "version": "0.1.6",
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
envpulse check  (v0.1.6)
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
envpulse check  (v0.1.6)
cwd: <scratch>/empty

no .env files found - nothing to cross-check.

scanned 0 source file(s), 0 variable(s) read by code

no problems found

0 problems
```

And when there is a `.env` but no template, it uses the `.env` itself as the reference and says so — note the **low**-severity `UNUSED` (it never fails a build) and the trailing `exit 0`:

```text
$ cd /tmp/dotenv-only && envpulse check
envpulse check  (v0.1.6)
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

1. **Parse** (`src/parser.ts`). A real dotenv parser, not a regex split: `export` prefixes, single/double/unquoted values, inline `#` comments (respecting quotes), `\n` / `\t` / `\"` escapes, multi-line double-quoted values, UTF-8 BOM, and CRLF/LF detection. Unparseable lines are collected into `EnvFile.invalid`, surfaced as `INVALID` findings and shown in `diff`, never silently dropped. A value that opens a PEM block swallows its body lines and keeps a SHA-256 digest of them, which is what lets `diff` see a rotated key whose header did not change.
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

**Does it upload my secrets anywhere?**  No. It never opens a socket. There is no telemetry, no registry call, no update check. Read `src/` — it is ~2,100 lines and imports only `node:fs`, `node:path`, `node:process`, `node:url` and `node:child_process` (the last one solely to run `git ls-files`, which reads your local index and touches no network).

**Will it flag a fake key in my test suite?**  Usually not: placeholders (`changeme`, `xxxx`, `your-key-here`, `sk_test_...`, `AKIAIOSFODNN7EXAMPLE`) are explicitly ignored. If a fixture still trips it, `--no-unsafe` disables the rule.

**My local `.env` really does hold live keys. Will that fail my build?**  No — only if git tracks it. An ignored `.env` produces no `UNSAFE` finding at all (case 3). The moment `git ls-files` reports it, the same value becomes `high`, because now it is in your history and on the remote.

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

### 它解决什么问题

每个团队的 `.env.example` 都会和 `.env` 漂移，`.env` 又会和代码漂移，而这些错误**全都是静默的**：

- 有人在代码里加了 `process.env.STRIPE_WEBHOOK_SECRET`，却忘了写进模板。生产环境凌晨两点因为 `undefined` 崩了。
- 功能下线了，`LEGACY_FLAG` 却永远留在 `.env.example` 里。新人照着过期配置复制。
- 有人为了「演示格式」，把真实的 `sk_live_...` 密钥贴进 `.env.example` 并提交了。
- `.env` 里 `PORT=` 定义了两次，最后一行静默生效，第一行是假的。

ESLint 不管这些，`dotenv` 不管这些，人工 review 在 400 行 diff 里也看不出来。envpulse 连 Node 启动在内跑完一次不到半秒（本机实测 5 次：264–351 毫秒）。

### 安装

`envpulse` **没有发布到 npm registry**。这个名字目前还是空的，只是本项目还没有发布凭据。
每个 release 都附带可直接安装的 tarball：

```bash
# 全局安装：直接从最新 release 装
npm install -g https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz
envpulse --version
```

每个 release 都用固定名字（`envpulse.tgz`）发布同一个 tarball，并附一份
`envpulse.tgz.sha256` 校验和。运行之前先验一下：

```bash
curl -sLO https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz
curl -sLO https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz.sha256
sha256sum -c envpulse.tgz.sha256          # envpulse.tgz: OK
npm install -g ./envpulse.tgz
```

macOS 上没有 `sha256sum`，用 `shasum -a 256 -c envpulse.tgz.sha256`。

```bash
# 或者装成项目的 devDependency
npm install -D https://github.com/kesheC/envpulse/releases/latest/download/envpulse.tgz
npx envpulse check
```

想自己编译就从源码来：

```bash
git clone https://github.com/kesheC/envpulse.git
cd envpulse
npm ci && npm run build && npm link
```

需要 Node.js >= 20.11。没有 `postinstall`，没有原生模块，运行时**不联网**。

### 快速开始

```bash
envpulse check                          # 体检当前仓库
envpulse check --json                   # 给 CI 用的 JSON
envpulse diff .env .env.example         # 对比两个文件（默认打码）
envpulse sync --from .env.example --to .env --dry-run
envpulse mask < .env                    # 贴到工单里也不会泄露
```

### 各命令说明

| 命令 | 作用 |
| --- | --- |
| `check` | 体检：缺失 / 未使用 / 漂移 / 重复 / 非法行 / 泄漏 / 空值。有 high 级问题退出码为 `1`。 |
| `diff <a> <b>` | 逐键对比两个 env 文件，**默认对值打码**，`--reveal` 才显示明文。 |
| `sync --from --to` | 把模板里有、目标文件里没有的键**按模板顺序插入**；绝不删除、绝不改动已有行。 |
| `mask` | 从 stdin 读 env 文本，把敏感值打码后输出。 |
| `init --from-code` | 扫描源码，反向生成 `.env.example` 骨架，按目录分组。 |

退出码：`0` 无高危问题，`1` 存在高危问题（或 `diff` 发现差异），`2` 用法错误。

真实运行输出见上方的英文部分 —— 每一个代码块都是在 `examples/` 目录和本仓库上实际跑出来的，不是编的。

### 几个关键设计

- **零依赖**是刻意的：安全工具自己成为供应链风险就很荒谬。整包 `npm pack` 出来 48 KB、解包 180 KB、36 个文件。
- **`UNSAFE` 只有三种情况**：① 真密钥在模板文件（`.env.example` / `.env.sample` / `.env.template`）里 —— 模板本来就是给人提交的，一定是 high；② 真密钥在**被 git 跟踪**的普通 `.env` 里 —— 有人把它提交了，同样 high，报错信息会写明 `in a file tracked by git`；③ 真密钥在**没被 git 跟踪**的 `.env` 里 —— 那正是 `.env` 的用途，不报、不吵。跟踪状态整轮只跑一次 `git ls-files`；机器上没有 git、或者当前目录不是仓库时，静默退化为只查模板，绝不因为 git 而崩掉。
- **打码看值，其次看名字**：`mask` 先判断值本身像不像密钥（带密码的连接串、PEM 私钥、高熵串……），再看键名里有没有 `SECRET` / `TOKEN` / `PASSWORD`。所以 `LOG_LEVEL=debug` 和无密码的 `DATABASE_URL` 保持可读，而键名叫 `DB`、值里带密码的照样打码。
- **PEM 整块打码，也整块比对**：私钥塞不进一行 env 值 —— 赋值行被打了码、后面的密钥正文却原样输出，这正是最常见的泄漏方式。`mask` 会一路吞到 `-----END ...-----` 那一行；`diff` 共用同一套判断，即使加 `--reveal` 也不显示 PEM 头。同时 `diff` 会为 PEM 正文算一个摘要参与比对，所以**只换了密钥正文、头没变**的轮换也能被发现，行数变了同样能。
- **不吞掉看不懂的行**：一行既不是注释也不是 `KEY=value` 时，`check` 报 `INVALID`（medium，指向具体行号），`diff` 也不会再说「完全相同」。典型场景是把 `DATABASE_URL=...` 写成 `DATABASE_URL ...`：变量彻底消失，以前只会得到一个指向「缺失」的误导性报告。
- **路径写错不是绿灯**：`check` / `init` 的 `--cwd` 会先校验目录存在，不存在就 `exit 2`，而不是打印「没找到 .env」然后退出 0。
- **`sync` 只插入、不重写**：直接对原始文本做行拼接，所以注释、引号风格、CRLF 换行全部原样保留。
- **占位符不算泄漏**：`changeme`、`xxxx`、`your-key-here`、`sk_test_...`、`AKIAIOSFODNN7EXAMPLE` 都会被放过。
- **不臆造问题**：仓库里没有 `.env` 模板时，它明确告诉你「无从比对」并退出 `0`，而不是假装发现了问题。

### 库 API

CLI 只是薄壳，核心能力都通过 `dist/index.js` 导出，无 `process.exit`、无 argv 解析：

```ts
import { checkProject, diffFiles, syncEnvFiles } from "envpulse";

const report = checkProject({ cwd: process.cwd() });
const diff = diffFiles('.env', '.env.example', '.env', '.env.example', { reveal: false });
const sync = syncEnvFiles({ from: '.env.example', to: '.env', dryRun: true });
```

## 安全与变更

发现安全问题请**不要**开公开 issue —— [SECURITY.md](SECURITY.md) 说明了私密上报渠道以及
需要提供哪些信息。每个版本的改动都记在 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT © 2026 kesheC。详见 [LICENSE](LICENSE)。