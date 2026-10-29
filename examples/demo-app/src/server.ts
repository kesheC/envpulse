import { readFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env["DATABASE_URL"] ?? "";
const logLevel = process.env.LOG_LEVEL ?? "info";
const verbose = process.env.DEBUG_VERBOSE === "true";
const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";

export function start(): string {
  const banner = readFileSync(new URL("./banner.txt", import.meta.url), "utf8");
  return [banner, port, databaseUrl, logLevel, verbose, stripeKey.length].join(" ");
}
