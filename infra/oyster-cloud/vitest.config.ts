import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Use isolated in-memory D1 per test file.
          d1Databases: ["DB"],
          // In-memory R2 bucket for session bytes tests.
          r2Buckets: ["SESSIONS_BUCKET"],
          // Encryption key fed in as a binding for tests; in production it's
          // a wrangler secret.
          bindings: {
            SESSIONS_ENCRYPTION_KEY: "test-master-secret-do-not-use-in-prod",
          },
        },
      },
    },
  },
});
