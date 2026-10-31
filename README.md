# envpulse

> **Your `.env` files are lying to you. envpulse finds out in one command.**

`envpulse` is a zero-dependency CLI that cross-checks your `.env` files against the variables your source code actually reads. It reports **missing**, **unused**, **drifting**, **duplicated**, and **leaked** values — including secrets committed by accident into `.env.example`.

[![CI](https://github.com/kesheC/envpulse/actions/workflows/ci.yml/badge.svg)](https://github.com/kesheC/envpulse/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kesheC/envpulse?color=blue)](https://github.com/kesheC/envpulse/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-informational.svg)](package.json)

**Zero runtime dependencies.** Node.js standard library only — nothing to audit, nothing to pin, nothing that breaks on a Tuesday. The whole installed package is ~40 KB of compiled TypeScript.

---

## The problem

Every team has a `.env.example` that drifted from `.env`, and a `.env` that drifted from the code. The failure modes are all silent:

- Someone adds `process.env.STRIPE_WEBHOOK_SECRET` to the code and never documents it. Production crashes at 2 AM on `undefined`.
- Someone deletes a feature but leaves `LEGACY_FLAG` in `.env.example` forever. New hires copy stale configs.
- Someone pastes a **real** `sk_live_...` key into `.env.example` "just to show the format" and commits it.
- `PORT=` is defined twice in `.env`; the last line silently wins, and the first line is a lie.

Linters don't check this. `dotenv` doesn't check this. Reviewers miss it in a 400-line diff. `envpulse` checks it in 200 ms.

## Install

`envpulse` is **not published to the npm registry** — the name there belongs to an
unrelated package. Every release ships a ready-to-install tarball instead:

```bash
# global install, straight from the latest release
npm install -g https://github.com/kesheC/envpulse/releases/download/v0.1.1/envpulse-0.1.1.tgz
envpulse --version
```

```bash
# or as a project dev dependency
npm install -D https://github.com/kesheC/envpulse/releases/download/v0.1.1/envpulse-0.1.1.tgz
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
| `UNSAFE` | **high** | A value in a **committed** env file looks like a live secret. |
| `EMPTY` | low | Declared with no value, so it will be `undefined` at runtime. |

Exit code: `0` when no high-severity finding exists, `1` when at least one does, `2` on bad usage. Drop it straight into CI:

```yaml
- run: envpulse check
```

Real output, run against the `examples/demo-app` fixture in this repository:

```text
$ envpulse check --cwd examples/demo-app
envpulse check  (v0.1.1)
cwd: E:\deepseek_workspace\github\projects\envpulse\examples\demo-app

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

`UNSAFE` only fires for files that are meant to be committed (`.env.example`, `.env.sample`, `.env.template`). Your real `.env` is allowed to hold real secrets — it just must not be committed.

### `envpulse diff <a> <b>` — compare without leaking

Values are masked by default. `diff` exits `1` when the files differ (same convention as GNU `diff`).

```text
$ envpulse diff .env .env.example
envpulse diff  (v0.1.1)
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

### `envpulse sync --from <template> --to <target>` — fix the drift

Adds every template key that is missing from the target, **in template order**, anchored to the next template key that already exists. Existing values, comments, ordering and line endings are preserved byte for byte. Nothing is ever deleted.

```text
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
DATABASE_URL=po****ev
STRIPE_SECRET_KEY=sk****C9
LOG_LEVEL=debug
DEBUG_VERBOSE=true
PORT=9090
```

Only keys that look sensitive (by name or by value pattern) are masked; harmless values like `LOG_LEVEL=debug` stay readable. Pass `--all` to mask everything.

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

Every command accepts `--json` for CI and dashboards:

```text
$ envpulse check --cwd examples/demo-app --json
{
  "tool": "envpulse",
  "version": "0.1.1",
  "command": "check",
  "cwd": ".../examples/demo-app",
  "envFiles": [
    {
      "path": ".env",
      "kind": "env",
      "keys": 5,
      "duplicates": ["PORT"]
    }
  ],
  "sourceFiles": 3,
  "variablesRead": ["DATABASE_URL", "DEBUG_VERBOSE", ...],
  "findings": [
    {
      "code": "MISSING",
      "severity": "high",
      "key": "DEBUG_VERBOSE",
      "file": ".env.example",
      "hits": [{ "file": "src/server.ts", "line": 6 }]
    }
  ],
  "counts": { "high": 3, "medium": 4, "low": 2 },
  "exitCode": 1
}
```

**What happens when there is no `.env` at all** — the honest answer, run against the workspace repository this tool was built in:

```text
$ envpulse check
envpulse check  (v0.1.1)
cwd: E:\deepseek_workspace\github

no .env files found - nothing to cross-check.

scanned 88 source file(s), 28 variable(s) read by code

no problems found
note: no template env file found, so MISSING cannot be reported. Create .env.example (try `envpulse init --from-code`).

0 problems
```

envpulse does not invent problems to look busy. With no template there is nothing to compare against, so it says so and exits `0`. In a directory with no source code either:

```text
$ envpulse check
no .env files found - nothing to cross-check.

scanned 0 source file(s), 0 variable(s) read by code

no problems found

0 problems
```

## How it works

1. **Parse** (`src/parser.ts`). A real dotenv parser, not a regex split: `export` prefixes, single/double/unquoted values, inline `#` comments (respecting quotes), `\n` / `\t` / `\"` escapes, multi-line double-quoted values, UTF-8 BOM, and CRLF/LF detection. Unparseable lines are reported, never silently dropped.
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

**Does it upload my secrets anywhere?**  No. It never opens a socket. There is no telemetry, no registry call, no update check. Read `src/` — it is ~1,900 lines and imports only `node:fs`, `node:path`, `node:os` and `node:process`.

**Will it flag a fake key in my test suite?**  Usually not: placeholders (`changeme`, `xxxx`, `your-key-here`, `sk_test_...`, `AKIAIOSFODNN7EXAMPLE`) are explicitly ignored. If a fixture still trips it, `--no-unsafe` disables the rule.

**Why not just use `dotenv-linter`?**  `dotenv-linter` checks style inside one file. envpulse checks the *relationship* between your env files and your source code — which is where real outages come from.

**It flagged a key my framework reads implicitly (Next.js, Vite, `NODE_ENV`).**  Declaring it in the template is the honest fix, since the framework does read it. `UNUSED` is low severity and never fails the build, so a false positive costs you nothing but a line of noise.

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

`envpulse` 是一个**零运行时依赖**的命令行工具（只用 Node.js 标准库），把 `.env` 文件和源码里真正读取的变量做交叉核对，报告 **缺失（MISSING）**、**未被使用（UNUSED）**、**文件间漂移（DRIFT）**、**重复定义（DUPLICATE）** 和 **真实密钥泄漏（UNSAFE）**。

### 它解决什么问题

每个团队的 `.env.example` 都会和 `.env` 漂移，`.env` 又会和代码漂移，而这些错误**全都是静默的**：

- 有人在代码里加了 `process.env.STRIPE_WEBHOOK_SECRET`，却忘了写进模板。生产环境凌晨两点因为 `undefined` 崩了。
- 功能下线了，`LEGACY_FLAG` 却永远留在 `.env.example` 里。新人照着过期配置复制。
- 有人为了「演示格式」，把真实的 `sk_live_...` 密钥贴进 `.env.example` 并提交了。
- `.env` 里 `PORT=` 定义了两次，最后一行静默生效，第一行是假的。

ESLint 不管这些，`dotenv` 不管这些，人工 review 在 400 行 diff 里也看不出来。envpulse 200 毫秒给你答案。

### 安装

`envpulse` **没有发布到 npm registry**（那个名字被别人占了）。每个 release 都附带
可直接安装的 tarball：

```bash
# 全局安装：直接从最新 release 装
npm install -g https://github.com/kesheC/envpulse/releases/download/v0.1.1/envpulse-0.1.1.tgz
envpulse --version
```

```bash
# 或者装成项目的 devDependency
npm install -D https://github.com/kesheC/envpulse/releases/download/v0.1.1/envpulse-0.1.1.tgz
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
| `check` | 体检：缺失 / 未使用 / 漂移 / 重复 / 泄漏 / 空值。有 high 级问题退出码为 `1`。 |
| `diff <a> <b>` | 逐键对比两个 env 文件，**默认对值打码**，`--reveal` 才显示明文。 |
| `sync --from --to` | 把模板里有、目标文件里没有的键**按模板顺序插入**；绝不删除、绝不改动已有行。 |
| `mask` | 从 stdin 读 env 文本，把敏感值打码后输出。 |
| `init --from-code` | 扫描源码，反向生成 `.env.example` 骨架，按目录分组。 |

退出码：`0` 无高危问题，`1` 存在高危问题（或 `diff` 发现差异），`2` 用法错误。

真实运行输出见上方的英文部分 —— 每一个代码块都是在 `examples/` 目录和本仓库上实际跑出来的，不是编的。

### 几个关键设计

- **零依赖**是刻意的：安全工具自己成为供应链风险就很荒谬。整包 ~40 KB。
- **只在「本该提交的」文件上查密钥**（`.env.example` / `.env.sample` / `.env.template`）。真实 `.env` 里放真密钥不是问题，提交上去才是。
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