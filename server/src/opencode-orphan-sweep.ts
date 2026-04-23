// Startup sweep for stale opencode-ai processes left behind by a previous
// Oyster run that died without reaping (SIGKILL, crash, OOM, laptop sleep).
// See #191 — without this, orphans accumulate across sessions and fill swap.
//
// Filter is deliberately tight: only processes whose kernel-visible parent
// is gone AND whose command line identifies them as opencode-ai. A live
// Oyster always has its opencode child parented to the server PID, so the
// parent-dead check alone is safe; the name match is belt-and-braces.

import { execSync } from "node:child_process";

const PROCESS_NAME_PATTERN = /opencode-ai/;

export function sweepOrphanOpenCodeProcesses(): { killed: number[]; errors: string[] } {
  if (process.platform === "win32") return sweepWindows();
  return sweepUnix();
}

function sweepUnix(): { killed: number[]; errors: string[] } {
  const killed: number[] = [];
  const errors: string[] = [];
  let output = "";
  try {
    output = execSync("ps -Ao pid=,ppid=,command=", { encoding: "utf8" });
  } catch (err) {
    errors.push(`ps failed: ${err instanceof Error ? err.message : err}`);
    return { killed, errors };
  }

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const command = match[3];
    if (ppid !== 1) continue;
    if (!PROCESS_NAME_PATTERN.test(command)) continue;
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (err) {
      errors.push(`kill ${pid}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { killed, errors };
}

function sweepWindows(): { killed: number[]; errors: string[] } {
  const killed: number[] = [];
  const errors: string[] = [];
  // One PowerShell call: enumerate opencode-ai.exe processes, filter those
  // whose ParentProcessId is not in the current live PID set, emit just the
  // orphan PIDs on stdout.
  const script = `
    $procs = Get-CimInstance Win32_Process -Filter "Name='opencode-ai.exe'"
    if (-not $procs) { return }
    $alive = @{}
    Get-Process | ForEach-Object { $alive[$_.Id] = $true }
    foreach ($p in $procs) {
      if (-not $alive.ContainsKey([int]$p.ParentProcessId)) {
        Write-Output $p.ProcessId
      }
    }
  `.trim();
  let output = "";
  try {
    output = execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, {
      encoding: "utf8",
    });
  } catch (err) {
    errors.push(`powershell enumeration failed: ${err instanceof Error ? err.message : err}`);
    return { killed, errors };
  }

  for (const line of output.split(/\r?\n/)) {
    const pid = parseInt(line.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      killed.push(pid);
    } catch (err) {
      errors.push(`taskkill ${pid}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { killed, errors };
}
