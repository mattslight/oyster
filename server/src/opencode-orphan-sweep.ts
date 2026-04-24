// Startup sweep for stale opencode-ai processes left behind by a previous
// Oyster run that died without reaping (SIGKILL, crash, OOM, laptop sleep).
// See #191 — without this, orphans accumulate across sessions and fill swap.
//
// Filter layers: (1) kernel-visible parent is gone (ppid==1 on Unix, parent
// PID not in live set on Windows); (2) command line matches an Oyster-owned
// opencode-ai path (either a substring of OPENCODE_BIN, or the generic
// "node_modules/opencode-ai" fingerprint of any npm-installed copy). This
// avoids killing a user's own manually-run opencode-ai installed elsewhere.

import { execSync } from "node:child_process";

const ENUMERATION_TIMEOUT_MS = 5000;
const NPM_OPENCODE_FINGERPRINT = "node_modules/opencode-ai";
const NPM_OPENCODE_FINGERPRINT_WIN = "node_modules\\\\opencode-ai";

export function sweepOrphanOpenCodeProcesses(opencodeBin?: string): { killed: number[]; errors: string[] } {
  if (process.platform === "win32") return sweepWindows(opencodeBin);
  return sweepUnix(opencodeBin);
}

function matchesOysterOpencode(command: string, opencodeBin: string | undefined, fingerprint: string): boolean {
  if (opencodeBin && command.includes(opencodeBin)) return true;
  return command.includes(fingerprint);
}

function sweepUnix(opencodeBin: string | undefined): { killed: number[]; errors: string[] } {
  const killed: number[] = [];
  const errors: string[] = [];
  let output = "";
  try {
    output = execSync("ps -Ao pid=,ppid=,command=", {
      encoding: "utf8",
      timeout: ENUMERATION_TIMEOUT_MS,
    });
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
    if (!matchesOysterOpencode(command, opencodeBin, NPM_OPENCODE_FINGERPRINT)) continue;
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (err) {
      errors.push(`kill ${pid}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { killed, errors };
}

function sweepWindows(opencodeBin: string | undefined): { killed: number[]; errors: string[] } {
  const killed: number[] = [];
  const errors: string[] = [];
  // Match on CommandLine rather than Name: on Windows opencode-ai is usually
  // launched as node.exe with the script path in CommandLine, not an
  // opencode-ai.exe image. The PS query below returns ProcessId and
  // CommandLine for every process whose CommandLine mentions opencode-ai;
  // we filter down to orphans + Oyster-owned paths on the JS side.
  // Pass the script via -EncodedCommand (base64 UTF-16LE) so cmd.exe never
  // sees the pipes, braces, or quotes embedded in the PowerShell body —
  // previously `execSync` with `-Command "..."` was mangled by cmd.exe's
  // quoting rules (the `|` inside `"{0}|{1}"` got parsed as a shell pipe,
  // yielding "empty pipe element" errors).
  const script = `
    $procs = Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'opencode-ai' }
    if (-not $procs) { return }
    $alive = @{}
    Get-Process | ForEach-Object { $alive[$_.Id] = $true }
    foreach ($p in $procs) {
      if (-not $alive.ContainsKey([int]$p.ParentProcessId)) {
        Write-Output ("{0}|{1}" -f $p.ProcessId, $p.CommandLine)
      }
    }
  `.trim();
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let output = "";
  try {
    output = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
      encoding: "utf8",
      timeout: ENUMERATION_TIMEOUT_MS,
    });
  } catch (err) {
    errors.push(`powershell enumeration failed: ${err instanceof Error ? err.message : err}`);
    return { killed, errors };
  }

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf("|");
    if (sep < 0) continue;
    const pid = parseInt(trimmed.slice(0, sep), 10);
    const cmd = trimmed.slice(sep + 1);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!matchesOysterOpencode(cmd, opencodeBin, NPM_OPENCODE_FINGERPRINT_WIN)) continue;
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", timeout: ENUMERATION_TIMEOUT_MS });
      killed.push(pid);
    } catch (err) {
      errors.push(`taskkill ${pid}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { killed, errors };
}
