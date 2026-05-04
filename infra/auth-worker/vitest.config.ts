import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The integration test file needs the workers pool; the two existing
    // pure-unit test files (oauth-helpers, return-path) import nothing
    // Cloudflare-specific so they run fine in the workers pool too.
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Isolated in-memory D1 per test file.
          d1Databases: ["DB"],
          bindings: {
            GITHUB_OAUTH_CLIENT_ID: "test-client-id",
            GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
            FROM_ADDRESS: "noreply@example.com",
            REPLY_TO: "test@example.com",
          },
          // wrangler.toml declares MAGIC_LINK_LIMIT with period = 3600 which
          // miniflare only accepts as 10 | 60. Override here with a valid
          // period so miniflare starts; tests stub the binding anyway via
          // `(env as any).MAGIC_LINK_LIMIT = { limit: async () => … }`.
          ratelimits: {
            MAGIC_LINK_LIMIT: { simple: { limit: 20, period: 60 } },
          },
        },
      },
    },
  },
});
