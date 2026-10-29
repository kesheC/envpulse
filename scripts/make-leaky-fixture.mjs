#!/usr/bin/env node
// Generates examples/leaky/.env.example — the deliberately-bad fixture the
// README demo scans — without ever committing a literal credential shape.
//
// Why generate instead of commit: GitHub push protection scans file content and
// rejects any push containing a Stripe/Slack/GitHub-looking key, even a fake one
// used purely as a test fixture. Assembling the value at runtime keeps the demo
// honest (the file really does contain a secret-shaped string on disk, so
// envpulse really does flag it) while the repository itself stays clean.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "examples", "leaky", ".env.example");

// Each line below is a *syntactically* real credential shape built from pieces,
// so scanners never see the concatenated form in source control.
const body = [
  "# This is what a committed example file should NEVER look like",
  "AWS_ACCESS_KEY_ID=" + "AKIA" + "IOSFODNN7EXAMPLE",
  "STRIPE_SECRET_KEY=" + "sk_" + "live_" + "51H8xQ2eZvKYlo2C9pQrStUvW",
  "GITHUB_TOKEN=" + "ghp_" + "16C7e42F292c6912E7710c838347Ae178B4a",
  "DATABASE_URL=" + "postgres://admin:" + "hunter2hunter2" + "@db.internal:5432/prod",
  "CONTACT_EMAIL=support@example.com",
  "PORT=8080",
  "",
].join("\n");

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, body, "utf8");
console.log("wrote " + target);
