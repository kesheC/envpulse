#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
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

Global options:
  -h, --help       Show help
  -v, --version    Show version
      --json       Machine readable JSON output (check, diff, sync, init)
      --reveal     Show plaintext secret values (diff, mask)
      --no-color   Disable ANSI colours

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
  mask: `envpulse mask [options] < input.env

Reads env text from stdin and writes it back with sensitive values masked.
Safe for pasting into an issue or a screenshot.

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

function cmdCheck(args: ParsedArgs): number {
  const cwd = path.resolve(stringFlag(args.flags, "cwd", "."));
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
  const input = readStdin();
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
  const cwd = path.resolve(stringFlag(args.flags, "cwd", "."));
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

  if (flag(args.flags, "version") || args.command === "version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (args.command === "") {
    process.stdout.write(HELP);
    return args.positionals.length > 0 ? 2 : 0;
  }
  if (args.command === "help" || flag(args.flags, "help")) {
    const page = COMMAND_HELP[args.command];
    process.stdout.write(page ?? HELP);
    return 0;
  }

  try {
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

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = path.resolve(process.argv[1] ?? "");
  const thisFile = path.resolve(fileURLToPath(import.meta.url));
  return self === thisFile;
})();

if (invokedDirectly) {
  process.exitCode = main();
}