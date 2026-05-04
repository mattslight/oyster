// Boot-pipeline profiler. Enabled when OYSTER_BOOT_PROFILE=1.
// Logs timestamped step markers so we can see where startup wallclock goes.
// See #385.

const enabled = process.env.OYSTER_BOOT_PROFILE === "1";
const t0 = performance.now();

export function bootMark(label: string): void {
  if (!enabled) return;
  const ms = Math.round(performance.now() - t0);
  console.log(`[boot:+${ms}ms] ${label}`);
}

export function bootTime<T>(label: string, fn: () => T): T {
  if (!enabled) return fn();
  const start = performance.now();
  const result = fn();
  const elapsed = Math.round(performance.now() - start);
  const since = Math.round(start - t0);
  console.log(`[boot:+${since}ms] ${label} (${elapsed}ms)`);
  return result;
}

export async function bootTimeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  const result = await fn();
  const elapsed = Math.round(performance.now() - start);
  const since = Math.round(start - t0);
  console.log(`[boot:+${since}ms] ${label} (${elapsed}ms)`);
  return result;
}
