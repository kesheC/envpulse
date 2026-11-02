# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The README advertised a tarball size that stopped being true two versions ago.** The intro said
  the published package was `45 KB packed / 136 KB unpacked, 25 files`; `npm pack --dry-run` on
  0.1.14 reports 50.6 kB packed, 151.1 kB unpacked and 27 files, because the release grew `dist/`
  entries without anyone revisiting the sentence. A number that tracks nothing is worse than no
  number: it is the one claim in the file a reader cannot check without running a command, so it
  is the one that rots. The sentence now states what actually ships — `dist/`, `README.md` and
  `LICENSE` — which is what CI asserts on every run and what stays true at any size.

- **The README quoted four `check` runs whose numbers nothing checked.** Every transcript ends
  with a line like `3 high, 4 medium, 2 low  -> exit 1`, and one `--json` body repeats the same
  three numbers as `counts`. Those numbers are claims about what a fixture on disk produces, but
  the fixtures are written by `scripts/make-demo-app.mjs` and `scripts/make-leaky-fixture.mjs`,
  which no reader re-reads and no test re-ran: adding one line to the demo `.env` moved the
  report and left the README quoting a run that no longer happens. `tests/readme.test.ts` now
  rebuilds each fixture from its generator in a throwaway directory, runs `checkProject` over the
  result, and asserts the README still carries the exact summary line and exit code — plus the
  three `counts` values in the JSON block. It also reconstructs the two smaller scenarios the
  README documents (a swallowed assignment, and a `.env` with no template) from the same prose
  the reader follows.
- **`npm test` failed in any checkout that was not itself a git work tree.** `fixtures.test.ts`
  guarded on `git --version` alone, so the "keeps every generated .env out of git" case ran
  `git ls-files` inside the package directory and its exit code depended on where the copy lived:
  a `git archive` export or an unpacked tarball has no `.git` and returned 128, while a copy made
  inside an unrelated repository answered about that repository instead. The guard now resolves
  `git rev-parse --show-toplevel` and skips unless the package directory *is* the work tree, so the
  assertion still runs in a real checkout and the test no longer depends on its surroundings.
- **The contributing guide still said the README transcripts are not re-run by CI.** That
  stopped being true when `tests/readme.test.ts` landed: it rebuilds every fixture from
  `scripts/` in a throwaway directory and asserts the four `check` summaries and the `--json`
  counts. The guide now says which blocks are under test and which were checked by hand.

## [0.1.14] - 2026-11-02

### Added

- **The files GitHub looks for on a healthy repository.** The repository had issue templates and
  workflows but no `CONTRIBUTING.md`, no `CODE_OF_CONDUCT.md` and no pull request template, so
  the community profile counted it as incomplete and a first-time contributor had to guess at the
  house rules. `CONTRIBUTING.md` writes down what the code actually depends on — zero runtime
  dependencies, ESM with NodeNext and `.js` import suffixes, strict TypeScript including
  `noUncheckedIndexedAccess`, stdout for machine output and stderr for human output, Node >= 20.11
  — plus the three local gates CI runs. `CODE_OF_CONDUCT.md` is Contributor Covenant 2.1 with
  reporting pointed at the private advisory channel. The pull request template asks for the command
  and its output, because "tests pass" only shows that nothing already covered broke.

### Fixed

- **The lockfile still described 0.1.0 with an engines floor of `>=20`.** It was last written
  before the version bumps, and nothing in CI reads it closely enough to fail, so a stale lock
  could have sat there indefinitely. Regenerating it against the current manifest brings the
  version, the root package entry and `engines.node` back in line.
- **The bug report template offered a version from nine releases ago.** It asked for `0.1.1` as
  the example version and pinned the install field to `.../download/v0.1.1/....tgz`. Both still
  resolve, so nothing was broken — but anyone filling the form in copies a stale shape and the
  report arrives describing a version nobody runs. The install placeholder now uses
  `releases/latest/download/`, which keeps working as releases move on.
- **The channel picker had no route to the one report that must not be public.** `config.yml` had
  `contact_links: []`; it now carries a link to the private security advisory page.
- **`CONTRIBUTING.md` was reachable only from the file list.** The security paragraph at the end
  of the README now points at it, in the same bilingual shape that paragraph already uses.

- **`CONTRIBUTING.md` promised a CI gate that does not exist here.** It said that a change
  touching a README transcript gets that transcript re-run by CI. Two of the six repositories
  have such a step; this one does not, so a contributor would have updated the README and waited
  for a check that never runs. The paragraph now says the transcripts are verified by hand and
  asks for the exact command and its output instead.

### Quality

- 158 tests across 11 spec files, 2540 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20, 22 and 24.
- Zero runtime dependencies.

## [0.1.13] - 2026-11-02

### Changed

- **Every README transcript now reproduces from a clean checkout.** Blocks that showed one
  directory ran from another, the headers above each finding list were missing, and three
  fixtures (`typo.env`, the PEM pair, the junk pair) were quoted without the command that writes
  them. Each block now names its directory — `examples/demo-app` or `examples/leaky` — and
  builds its fixture with `printf` before the run that reads it.

### Fixed

- **The changelog described a CI matrix that no longer existed.** Every quality note from 0.1.2
  onwards said "Node 20 and 22", but the matrix has run 20, 22 and 24 since that release — so each
  of those sections, and the GitHub release notes generated from them, named a matrix the project
  had already outgrown. The notes now list the versions CI actually runs.

### Quality

- 158 tests across 11 spec files, 2540 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20, 22 and 24.
- Zero runtime dependencies.

## [0.1.12] - 2026-11-02

### Fixed

- **A closed pipe is an ending, not a crash.** `envpulse check | head -5` printed its
  first lines and then died with `Error: write EPIPE` and exit 1: the reader
  had what it wanted, Node raised an error event on stdout, and nothing was
  listening, so a finished run looked like a failed one. stdout now reads a
  closed pipe as "the reader is done" and exits 0; stderr carries only
  progress and warnings, so an EPIPE there is swallowed and the command runs
  to the end. Any other stream error is still thrown.

### Quality

- 158 tests across 11 spec files, 2540 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20, 22 and 24.
- Zero runtime dependencies.

## [0.1.11] - 2026-11-01

### Fixed

- **`--version` is a top-level request, not a per-command flag.** `envpulse
  check --version` printed the version and exited 0 without checking anything,
  and `envpulse mask --version` looked like a masked run. Every command now
  refuses it: ``envpulse: --version is not supported by `check`; it applies to
  "envpulse --version" on its own``. `--help` is unchanged.
- **A failure is a document too, not just a sentence.** `envpulse check --json
  --cwd /missing` exited 2 and wrote nothing to stdout, so a wrapper could not
  tell a failed check from a clean one. Every failure path (`--json`) now emits
  `{"error":{"message":...,"exitCode":n}}` on stdout as well, with the
  exit code the run really used; the stderr sentence is unchanged and stdout
  stays empty when `--json` was not asked for.

### Quality

- 156 tests across 10 spec files, 2507 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20, 22 and 24.
- Zero runtime dependencies.

## [0.1.10] - 2026-11-01

### Fixed

- **Running `envpulse` with no arguments now exits 2, not 0.** The help text
  is the same; the exit code is not. Every other tool in this set treats a call
  that asked for nothing as a usage error, and a script that ran
  `envpulse && deploy` was told the check had passed. `--help` still exits 0,
  because the reader asked for the text.
- **A switch given a value is now a usage error.** `envpulse check --json=1`
  stored the string "1" while every reader tests `=== true`, so the flag looked
  set and did nothing: the run printed its human report and exited as if the
  flag had never been passed. `--json=true` and `--json=false` were treated
  the same way. Options that genuinely take a value still accept either
  spelling, so `--cwd=.` and `--cwd .` remain the same.

### Quality

- 152 tests across 10 spec files, 2,464 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20, 22 and 24.
- Zero runtime dependencies.

## [0.1.9] - 2026-11-01

### Added

- **The README is Chinese as well as English.** The nine H3 sections under
  `## 中文` now cover the same ground as the English text -- problem, install,
  quick start, usage, how it works, API, FAQ, security and changelog, licence.
  2,499 CJK characters, up from 1,667.

### Fixed

- **`envpulse check --reveal` exited 0 having ignored the flag.** Every command
  shared one option table, so any option was accepted everywhere and simply
  went unread -- indistinguishable from a run that found nothing. Each command
  now declares the options it reads (`COMMAND_FLAGS` in `src/cli.ts`) and
  anything else is a usage error that names the commands that do read it:
  ``envpulse: `check` does not read --reveal; it applies to diff, mask``.
  `--help` and `--version` stay universal.
- **The 0.1.8 notes now match what changed.** The sourcemap removal is its own
  bullet instead of a clause inside the `clean` one, with the measured numbers:
  eleven `.js.map` files and 74,771 bytes that used to ship in a 36-file
  tarball, now 25 files. Version headings got their link definitions, so
  `[0.1.7]` and `[0.1.8]` no longer render as literal text, and `[Unreleased]`
  compares against v0.1.8 instead of v0.1.6.

### Quality

- 149 tests across 10 spec files, 2,455 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20, 22 and 24.
- Zero runtime dependencies.

## [0.1.8] - 2026-11-01

### Added

- **`release.yml` had no tag/version gate at all**, alone among these packages:
  a `v0.1.9` tag on a `0.1.8` tree would have uploaded the old tarball without
  complaint. It now stops before the CHANGELOG lookup and before any `gh` call,
  and prints both sides when they disagree.
- **The release gates are executed, not spell-checked.** `tests/workflow.test.ts`
  cuts each guard's own shell body out of the workflow and runs it -- the tag
  gate against matching, drifted, non-semver and prerelease tags; the
  package-contents assertion against a complete manifest, a stray `.js.map`, an
  empty `dist/` and a leaked `src/`. 21 cases.
- **The published tarball no longer carries dead sourcemaps.** `tsconfig.build.json`
  kept inheriting `sourceMap: true`, so `npm pack` shipped eleven `.js.map` files
  that point at a `src/` the package does not contain -- files nobody can open.
  The build config now turns `sourceMap` and `declarationMap` off, and
  `tests/package.test.ts` fails if a map comes back.
- **`npm run build` now clears `dist/` first.** This package was the last one
  without a `clean` script, so turning sourcemaps off would have left the
  previous build's eleven `.js.map` files in `dist/` and `npm pack` would have
  shipped them anyway. The tarball went from 36 files to 25, about a fifth
  smaller.
- `pack-meta.json`, written by the CI package-contents assertion, is ignored.

## [0.1.7] - 2026-11-01

### Fixed

- **A rotated private key is no longer "files are identical".** `diff`
  compared env values only, and a PEM block never lives in a value: the key
  material sits on the lines after `KEY=-----BEGIN ...`, landed in
  `EnvFile.invalid`, and was compared by nobody. The parser now consumes the
  body behind a `KEY=-----BEGIN` header and keeps a SHA-256 digest of it, and
  `diff` compares that digest, so a same-header/different-body rotation is
  reported. The body is hashed, never printed, so `--reveal` still cannot leak
  one.
- **An unparseable line is never printed verbatim.** That was the one place a
  secret had no structure to mask: a PEM body behind a blank line, a bare
  `-----BEGIN` under an empty `KEY=`, a lowercase RFC 7468 label, or a base64
  line ending in `=` all fell through and the key material reached stdout.
  `EnvFile.invalid` now stores a descriptor (line, length, key-material flag,
  digest), `check` reports `INVALID` per swallowed line, and `diff` compares
  digests rather than text.
- **Swallowed lines no longer make a broken `.env` look clean.** `junk.env`
  and `junk2.env` compared equal, and a `DATABASE_URL postgres://...` typo made
  the variable vanish — `check` then reported it as MISSING, pointing away
  from the real problem.
- **A real secret in a git-tracked `.env` is now caught.** `UNSAFE` looked only
  at example files, so a live key stayed silent even after `git add .env &&
  git commit`. It now has three cases: a secret in a template file stays high;
  the same secret in a tracked `.env` is high with an 'in a file tracked by
  git' message; an untracked `.env` produces no finding, because that is what
  `.env` is for. Tracking comes from one `git ls-files -z` per run and
  degrades silently outside a repository.
- **`mask` follows a PEM block to its closing marker.** It only ever saw one
  env value, so everything after the assignment leaked; `diff` shares the
  predicate, so a header stays masked even with `--reveal`.
- **A typo in `--cwd` no longer looks like a clean repo.** `check` and `init`
  resolved `--cwd` without checking it, so a wrong path printed 'no .env files
  found' and exited 0. Both now stat the directory and exit 2 with `--cwd ...
  does not exist` / `is not a directory`.

### Changed

- **`mask` takes a file argument**, so `envpulse mask .env` does what it looks
  like it does instead of waiting on stdin.
- The high-entropy rule no longer flags credential-free connection strings such
  as `postgres://localhost:5432/demo_dev`.
- `examples/demo-app/.env` is generated by `scripts/make-demo-app.mjs` and
  gitignored — a tool that catches secrets in tracked `.env` files should not
  ship one. `tests/fixtures.test.ts` pins that.
- `README` documents the `INVALID` finding, the PEM digest, the bad-`--cwd`
  exit codes, all three `UNSAFE` cases, and the value-first masking rule, and
  every sample block was re-captured from a real run.

## [0.1.6] - 2026-11-01

### Fixed

- **The README shipped the author's absolute paths.** Two sample transcripts printed a real local working directory. The released tarball bundles the README, so those paths were going out to every user; they are now `<repo>/...` and `<workspace>`, with a line saying only the path differs on your machine.
- **The README claimed the npm name was taken.** It said the `envpulse` name on npm belonged to an unrelated package. It does not: `npm view envpulse` returns 404, the name is unregistered. The README now says this project has no publishing credentials yet, instead of blaming a squatter.

## [0.1.5] - 2026-11-01

### Changed

- **The release page now explains the release.** The workflow used to publish a body containing only a compare link, so the one page a prospective user lands on said nothing about what changed. The body is now the `CHANGELOG.md` section for the tag, and a tag with no written section fails the job instead of shipping an empty release.

## [0.1.4] - 2026-11-01

### Changed

- **README examples showed a version the tarball no longer ships.** The released tarball bundles the README, so a stale `0.1.2` in sample transcripts and JSON output was shipping to users. Every version string in it now matches the package.
- The install section documents the `envpulse.tgz.sha256` checksum every release publishes, so a download can be verified before it is executed.

## [0.1.3] - 2026-11-01

### Fixed

- **The CLI exited silently when started from an npm bin link.** The entry
  guard compared `process.argv[1]` with `import.meta.url` as raw strings. Node
  resolves `import.meta.url` to the real path but leaves `argv[1]` as written,
  so whenever the binary was reached through a link the guard was false, `main`
  never ran, and the process exited 0 having printed nothing. Every invocation
  is compared through `realpathSync` on both sides now, with a regression test
  that runs the built binary through a link and a CI step that asserts the
  printed version instead of only the exit code.

## [0.1.2] - 2026-11-01

### Changed

- **CI runs every Node version the package claims to support.** The matrix was
  Node 20 and 22; it is now 20, 22 and 24. The floor still matches `engines`,
  and 24 is the current active LTS.
- **CI now installs the packed tarball and runs the binary from it.** Tests
  prove the source compiles; this proves the thing users download works.
- GitHub Actions moved from `checkout@v4` / `setup-node@v4` to `v5`, which runs
  on Node 24 and clears the Node 20 deprecation warning on every job.
- The README install commands point at
  `releases/latest/download/NAME.tgz` instead of a version-pinned URL, so the
  documented command keeps working across releases. Each release now uploads a
  stable-named copy next to the versioned tarball.

## [0.1.1] - 2026-10-31

### Fixed

- **Install instructions that could not work.** The README told you to run
  `npm install -g github:kesheC/envpulse`, which resolves to an SSH URL, and in
  the case of `envpulse` also implied an npm registry package that does not exist.
  Both paths are gone. The documented install path is now the release tarball,
  which is built, smoke-tested and uploaded by CI on every tag.

### Added

- `.github/workflows/release.yml`: on a `v*` tag, build, test, `npm pack`, install
  the resulting tarball in a clean directory, run the packaged binary, then upload
  the tarball and its `.sha256` to the GitHub Release.
- `SECURITY.md` with a supported-versions table, a private reporting channel and an
  explicit in-scope / out-of-scope list.
- `prepack` script, so `npm pack` always ships a freshly built `dist/`.
- `author`, `bugs` and `homepage` fields in `package.json`.

### Changed

- `engines.node` is now `>=20.11` for every release artefact, matching the oldest
  Node version the test matrix exercises.
- The build hook moved from `prepare` to `prepack`. `prepare` ran on every
  consumer's machine during install — where `devDependencies` are absent — and npm
  11 warns loudly about unreviewed install scripts, so the documented install path
  printed a warning for no benefit. The tarball now ships a prebuilt `dist/`.

### Removed

- npm registry badges and `npm install -D envpulse` snippets that pointed at an
  unrelated (or non-existent) registry package.

## [0.1.0] - 2026-10-29

### Added

- Initial release: Audit .env drift and secret leaks in your repository.

- `envpulse check` compares `.env`, `.env.example` and the variables the code actually reads, and reports drift in both directions.
- Secret detection across committed files, with `--reveal` opt-in for local debugging and masked output by default.
- `envpulse diff` shows added / removed / renamed keys between two environments.
- `envpulse sync` regenerates the example file from the current source of truth.
- `envpulse mask` redacts values in place for screenshots and issue reports.
- `envpulse init` scaffolds the config; `--json` output for CI; exit codes 0 / 1 / 2.

### Quality

- 88 tests across 6 spec files, 1956 lines of TypeScript.
- CI matrix: Ubuntu and Windows, Node 20 and 22.
- Zero runtime dependencies.

[0.1.11]: https://github.com/kesheC/envpulse/compare/v0.1.10...v0.1.11
[0.1.12]: https://github.com/kesheC/envpulse/compare/v0.1.11...v0.1.12
[0.1.13]: https://github.com/kesheC/envpulse/compare/v0.1.12...v0.1.13
[0.1.14]: https://github.com/kesheC/envpulse/compare/v0.1.13...v0.1.14
[Unreleased]: https://github.com/kesheC/envpulse/compare/v0.1.14...HEAD
[0.1.10]: https://github.com/kesheC/envpulse/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/kesheC/envpulse/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/kesheC/envpulse/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/kesheC/envpulse/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/kesheC/envpulse/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/kesheC/envpulse/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/kesheC/envpulse/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/kesheC/envpulse/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kesheC/envpulse/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kesheC/envpulse/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kesheC/envpulse/releases/tag/v0.1.0