// Tell TypeScript what the test runtime's `env` looks like.
// @cloudflare/vitest-pool-workers exports `env: ProvidedEnv` which is
// otherwise empty until augmented here.

import type { Env } from "../src/worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
