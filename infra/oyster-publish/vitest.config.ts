import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Use isolated in-memory D1 + R2 per test file.
          d1Databases: ["DB"],
          r2Buckets: ["ARTIFACTS"],
          bindings: {
            VIEWER_COOKIE_SECRET: "test-secret-for-vitest-only",
          },
        },
      },
    },
  },
});
