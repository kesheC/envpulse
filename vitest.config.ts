import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    // Shelling out to git on the Windows runners routinely exceeds the 5s
    // default; the suite is still fast end to end.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});