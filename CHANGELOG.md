# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The README shipped the author's absolute paths.** Two sample transcripts printed a real local working directory. The released tarball bundles the README, so those paths were going out to every user; they are now `<repo>/...` and `<workspace>`, with a line saying only the path differs on your machine.

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

[Unreleased]: https://github.com/kesheC/envpulse/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/kesheC/envpulse/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/kesheC/envpulse/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/kesheC/envpulse/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kesheC/envpulse/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kesheC/envpulse/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kesheC/envpulse/releases/tag/v0.1.0