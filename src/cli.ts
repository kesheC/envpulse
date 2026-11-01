#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { checkProject } from "./checker.js";
import { diffFiles } from "./diff.js";
import { initFromCode, maskText, syncEnvFiles } from "./fix.js";
import { VERSION, formatCheckReport, formatDiffReport } from "./report.js";
import type { CheckReport, DiffReport } from "./types.js";

const HELP = `envpulse ${VERSION} - .env drift & secret leak doctor

Usage: envpulse <command> [options]

Commands:
  check            Cross-check .env files against the source code
  diff <a> <b>     Show key/value differences between two env files
  sync             Copy missing keys from a template into a target file
  mask             Read .env text on stdin and print it with secrets masked
  init             Generate a .env.example skeleton from the source code

Run \`envpulse <command> --help\` for command specific options.

Global options (every command):
  -h, --help       Show help
  -v, --version    Show version (top level only)

Options accepted by some commands:
      --json       Machine readable JSON output (check, diff, sync, init)
      --reveal     Show plaintext secret values (diff, mask)
      --no-color   Disable ANSI colours (check, diff, sync)

Exit codes:
  0  no high severity problems
  1  at least one high severity problem
  2  bad usage / unreadable input
`;

const COMMAND_HELP: Record<string, string> = {
  check: `envpulse check [options]

Cross-checks every .env file in the project against the variables the source
code actually reads. Reports MISSING, UNUSED, DRIFT, DUPLICATE, UNSAFE, EMPTY.

Options:
  --cwd <dir>         Directory to inspect (default: .)
  --template <file>   Env file to treat as the template (default: best example file)
  --no-unsafe         Skip secret detection entirely
  --no-unused         Skip the UNUSED rule
  --json              Machine readable output
  --no-color          Disable ANSI colours
`,
  diff: `envpulse diff <a.env> <b.env> [options]

Lists keys only in A, keys only in B, and keys whose values differ.
Values are masked by default.

Options:
  --reveal            Show plaintext values
  --json              Machine readable output
  --no-color          Disable ANSI colours
`,
  sync: `envpulse sync --from <template> --to <target> [options]

Appends every key of the template that is missing from the target, in template
order, reusing the target's existing quoting and comment layout. Existing values
and comments are never modified, and nothing is ever deleted.

Options:
  --from <file>       Template env file (default: .env.example)
  --to <file>         Target env file (default: .env)
  --dry-run           Print what would change without writing
  --json              Machine readable output
  --no-color          Disable ANSI colours
`,
  mask: `envpulse mask [options] [file]

Reads env text from stdin (or from <file>) and writes it back with sensitive
values masked. Safe for pasting into an issue or a screenshot.

Options:
  --all               Mask every value, not only the sensitive ones
  --no-key-names      Only use value heuristics, ignore secret-looking key names
  --reveal            Disable masking (identity transform, for diffing)
`,
  init: `envpulse init [options]

Scans the source code for environment variables it reads and writes a
.env.example skeleton grouped by source directory.

Options:
  --from-code         Scan the source tree (currently the only mode)
  --cwd <dir>         Directory to scan (default: .)
  --out <file>        Output file (default: .env.example)
  --force             Overwrite the output file if it exists
  --dry-run           Print the skeleton without writing it
  --json              Machine readable output
`,
};

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command = "";
  const valueFlags = new Set(["cwd", "template", "from", "to", "out"]);
  const booleanFlags = [
    "help", "version", "json", "reveal", "no-color", "dry-run", "force", "all",
    "no-key-names", "no-unsafe", "no-unused", "from-code", "quiet",
  ];
  const knownFlags = new Set<string>([...valueFlags, ...booleanFlags]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) {
        // "--json=1" used to be stored as the string "1", which every reader
        // tests with === true, so the flag silently did nothing while looking
        // like it had been set. A value on a switch is a typo, not a setting.
        if (!valueFlags.has(name)) fail(`--${name} does not take a value`);
        flags[name] = arg.slice(eq + 1);
        continue;
      }
      if (valueFlags.has(name)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) fail(`--${name} needs a value`);
        flags[name] = next ?? "";
        i += 1;
        continue;
      }
      if (!knownFlags.has(name)) fail(`unknown option --${name}`);
      flags[name] = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1);
      if (short === "h") flags.help = true;
      else if (short === "v") flags.version = true;
      else fail(`unknown option -${short}`);
      continue;
    }
    if (command === "") command = arg;
    else positionals.push(arg);
  }
  return { command, positionals, flags };
}

/**
 * Which options each command actually reads. Anything outside its set is a
 * usage error: `envpulse check --reveal` used to exit 0 having ignored the
 * flag, which looks exactly like a check that ran and found nothing.
 * Keep this table in step with cmdCheck/cmdDiff/cmdSync/cmdMask/cmdInit.
 */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  check: ["cwd", "template", "no-unsafe", "no-unused", "json", "no-color"],
  diff: ["reveal", "json", "no-color"],
  sync: ["from", "to", "dry-run", "json", "no-color"],
  mask: ["all", "no-key-names", "reveal"],
  init: ["from-code", "cwd", "out", "force", "dry-run", "json"],
};

/** Flags that mean the same thing everywhere and are validated globally. */
const UNIVERSAL_FLAGS: readonly string[] = ["help", "version"];

function rejectUnreadFlags(args: ParsedArgs): void {
  const allowed = COMMAND_FLAGS[args.command];
  if (allowed === undefined) return;
  const accepted = new Set<string>([...allowed, ...UNIVERSAL_FLAGS]);
  for (const name of Object.keys(args.flags)) {
    if (accepted.has(name)) continue;
    const used = Object.keys(COMMAND_FLAGS)
      .filter((command) => (COMMAND_FLAGS[command] ?? []).includes(name))
      .sort();
    const applies = used.length === 0 ? "it is not an envpulse option" : `it applies to ${used.join(", ")}`;
    fail(`\`${args.command}\` does not read --${name}; ${applies}`);
  }
}

class UsageError extends Error {
  readonly exitCode = 2;
}

function fail(message: string): never {
  throw new UsageError(message);
}

function flag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

function stringFlag(flags: Record<string, string | boolean>, name: string, fallback: string): string {
  const raw = flags[name];
  return typeof raw === "string" ? raw : fallback;
}

function useColor(flags: Record<string, string | boolean>): boolean {
  if (flag(flags, "no-color")) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  return process.stdout.isTTY === true;
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, jsonReplacer, 2) + "\n");
}

/** Drop the Map wrapper so JSON stays stable. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

/**
 * `--cwd` used to be resolved but never checked, so a typo produced a cheerful
 * "no .env files found" report and exit 0 - a green CI for a path that does not
 * exist. Anything that reads the tree must call this first.
 */
function resolveCwd(args: ParsedArgs): string {
  const cwd = path.resolve(stringFlag(args.flags, "cwd", "."));
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    fail(`--cwd ${cwd} does not exist`);
  }
  if (!isDirectory) fail(`--cwd ${cwd} is not a directory`);
  return cwd;
}

function cmdCheck(args: ParsedArgs): number {
  const cwd = resolveCwd(args);
  const template = typeof args.flags.template === "string" ? args.flags.template : undefined;
  const report = checkProject({
    cwd,
    template,
    noUnsafe: flag(args.flags, "no-unsafe"),
    noUnused: flag(args.flags, "no-unused"),
  });
  if (flag(args.flags, "json")) {
    printJson(report);
  } else {
    process.stdout.write(formatCheckReport(report, { color: useColor(args.flags) }) + "\n");
  }
  return report.exitCode;
}

function cmdDiff(args: ParsedArgs): number {
  const [a, b] = args.positionals;
  if (a === undefined || b === undefined) fail("diff needs two files: envpulse diff <a.env> <b.env>");
  assertReadable(a);
  assertReadable(b);
  const report: DiffReport = diffFiles(path.resolve(a), path.resolve(b), a, b, {
    reveal: flag(args.flags, "reveal"),
  });
  if (flag(args.flags, "json")) printJson(report);
  else process.stdout.write(formatDiffReport(report, { color: useColor(args.flags), reveal: flag(args.flags, "reveal") }) + "\n");
  return report.identical ? 0 : 1;
}

function cmdSync(args: ParsedArgs): number {
  const from = stringFlag(args.flags, "from", ".env.example");
  const to = stringFlag(args.flags, "to", ".env");
  assertReadable(from);
  const result = syncEnvFiles({ from: path.resolve(from), to: path.resolve(to), dryRun: flag(args.flags, "dry-run") });
  if (flag(args.flags, "json")) {
    printJson({ ...result, output: flag(args.flags, "json") ? result.output : undefined });
    return 0;
  }
  const c = useColor(args.flags);
  const tag = (text: string): string => (c ? `\u001b[36m${text}\u001b[0m` : text);
  const dim = (text: string): string => (c ? `\u001b[2m${text}\u001b[0m` : text);
  if (result.changes.length === 0) {
    process.stdout.write(`${to} is already up to date with ${from}\n`);
  } else {
    process.stdout.write(`${result.dryRun ? "would add" : "added"} ${result.changes.length} key(s) to ${to}\n`);
    for (const change of result.changes) process.stdout.write(`  ${tag("+")} ${change.key}\n`);
    if (result.dryRun) process.stdout.write(dim("dry run - nothing written\n"));
  }
  if (result.staleKeys.length > 0) {
    process.stdout.write(dim(`${result.staleKeys.length} key(s) in ${to} are not in the template (kept): ${result.staleKeys.join(", ")}\n`));
  }
  return 0;
}

function cmdMask(args: ParsedArgs): number {
  // Silently ignoring a path argument meant `envpulse mask .env` exited 0 with
  // no output and no change - indistinguishable from success. Reading a named
  // file is the obvious expectation, so do that.
  const named = args.positionals[0];
  const input = named === undefined ? readStdin() : readNamedFile(named);
  if (flag(args.flags, "reveal")) {
    process.stdout.write(input);
    return 0;
  }
  const output = maskText(input, {
    all: flag(args.flags, "all"),
    byKeyName: !flag(args.flags, "no-key-names"),
  });
  process.stdout.write(output);
  return 0;
}

function cmdInit(args: ParsedArgs): number {
  const cwd = resolveCwd(args);
  const out = stringFlag(args.flags, "out", ".env.example");
  const result = initFromCode({ cwd, out, force: flag(args.flags, "force"), dryRun: flag(args.flags, "dry-run") });
  if (flag(args.flags, "json")) {
    printJson(result);
    return 0;
  }
  if (flag(args.flags, "dry-run")) process.stdout.write(result.content);
  else process.stdout.write(`wrote ${result.out} with ${result.keys.length} key(s)\n`);
  return 0;
}

function readNamedFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    fail(`cannot read ${file}`);
  }
}

function readStdin(): string {
  // Reading a terminal would block forever; ask for a pipe instead.
  if (process.stdin.isTTY === true) throw new UsageError("mask expects .env content on stdin, e.g. envpulse mask < .env");
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}


function assertReadable(file: string): void {
  try {
    if (!statSync(file).isFile()) fail(`${file} is not a regular file`);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    fail(`cannot read ${file}`);
  }
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`envpulse: ${error.message}\n\n${HELP}`);
      return 2;
    }
    throw error;
  }

  // --version is a request about the tool, not about the run: `envpulse check
  // --version` printed the version and exited 0 without checking anything, and
  // `envpulse mask --version` looked like a masked run. --help is different --
  // every command has one, and it does what it says.
  if (args.command === "version" || (args.command === "" && flag(args.flags, "version"))) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (flag(args.flags, "version") && Object.hasOwn(COMMAND_FLAGS, args.command)) {
    process.stderr.write(
      `envpulse: --version is not supported by \`${args.command}\`; it applies to "envpulse --version" on its own\n`,
    );
    return 2;
  }
  if (args.command === "") {
    // Running the binary with no arguments asked for nothing, so it exits like
    // every other usage error in this set. --help prints the same text and
    // exits 0: the reader asked for it. (The old branch returned 0 for both,
    // and its `positionals.length > 0` arm was unreachable -- the parser only
    // starts collecting positionals after the command has been set.)
    process.stdout.write(HELP);
    return flag(args.flags, "help") ? 0 : 2;
  }
  if (args.command === "help" || flag(args.flags, "help")) {
    const page = COMMAND_HELP[args.command];
    process.stdout.write(page ?? HELP);
    return 0;
  }

  try {
    rejectUnreadFlags(args);
    switch (args.command) {
      case "check": return cmdCheck(args);
      case "diff": return cmdDiff(args);
      case "sync": return cmdSync(args);
      case "mask": return cmdMask(args);
      case "init": return cmdInit(args);
      default:
        process.stderr.write(`envpulse: unknown command "${args.command}"\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`envpulse: ${error.message}\n`);
      return 2;
    }
    // Runtime failures (unreadable file, existing output) are not usage errors.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`envpulse: ${message}\n`);
    return 1;
  }
}

// realpathSync on both sides: npm links the bin shim to this file, so
// process.argv[1] is the symlink while import.meta.url is already the real
// path. Comparing raw paths makes the CLI exit silently doing nothing.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = main();
}