// Minimal worker that delegates every request to the static-assets binding.
// docs/arcade/ contents are served at arcade.oyster.to/*. The 404 page lives
// in the assets dir (not_found_handling = "404-page" in wrangler.toml).
//
// The worker entry point exists only so we have a place to grow if we later
// want to inject headers, redirect old paths, or intercept /api/* —
// otherwise the assets binding handles everything.

export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(req);
  },
};
