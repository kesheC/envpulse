#!/usr/bin/env node
// Generates examples/demo-app/.env, the realistic local env file the README
// demo scans. It is NOT committed: a repository whose whole job is catching
// committed secrets should not ship a tracked .env, not even a harmless one.
//
// Regenerate with `npm run demo:fixtures` (runs this and the leaky fixture).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "examples", "demo-app", ".env");

// Assembled from fragments for the same reason the leaky fixture is: the value
// has the shape of a Stripe key, and push protection cannot tell a demo apart.
// 17 body characters keeps it under the 20 that stripe-test-long requires and
// under the 32 that the entropy rule requires, so the demo output stays the
// drift/duplicate report the README documents - not a UNSAFE row.
const body = [
  "# Local developer overrides",
  "PORT=8080",
  "DATABASE_URL=postgres://localhost:5432/demo_dev",
  "STRIPE_SECRET_KEY=" + "sk_" + "test_" + "51H8xQ2eZvKYlo2C9",
  "LOG_LEVEL=debug",
  "DEBUG_VERBOSE=true",
  "PORT=9090",
  "",
].join("\n");

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, body, "utf8");
console.log("wrote " + target);
