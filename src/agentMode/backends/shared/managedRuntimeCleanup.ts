import { v4 as uuidv4 } from "uuid";
import { logWarn } from "@/logger";
import { requireNodeModule } from "@/utils/desktopRuntime";
import { compareSemver } from "@/utils/semver";
import type { BinarySettings } from "./ManagedBinaryManager";

const ISSUE = "https://github.com/Brevilabs/obsidian-copilot-private/issues/537";
const LOCK_WAIT_MS = 10_000;

/**
 * Serializes cooperating vaults' publication, startup and reclamation.
 * @param root - Backend-owned installation root.
 * @param body - Work requiring exclusive access to that root.
 */
export async function withManagedRuntimeLock<T>(root: string, body: () => Promise<T>): Promise<T> {
  const fs = requireNodeModule<typeof import("node:fs")>("fs");
  const path = requireNodeModule<typeof import("node:path")>("path");
  await fs.promises.mkdir(root, { recursive: true });
  const locks = `${root}.runtime-locks`;
  await fs.promises.mkdir(locks, { recursive: true });
  const id = `${process.pid}-${uuidv4()}`;
  const claim = path.join(locks, id);
  await fs.promises.mkdir(claim);
  const readClaims = async (): Promise<{ id: string; ticket: number | null }[]> => {
    const claims: { id: string; ticket: number | null }[] = [];
    for (const entry of await fs.promises.readdir(locks)) {
      const pid = Number(entry.split("-")[0]);
      // Claims have unique names: reclaiming a dead owner cannot remove a new
      // owner's lock, even when several vaults recover simultaneously. See ISSUE.
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            await fs.promises.rm(path.join(locks, entry), { recursive: true, force: true });
            continue;
          }
        }
      }
      try {
        const ticket = Number(
          await fs.promises.readFile(path.join(locks, entry, "ticket"), "utf8")
        );
        claims.push({
          id: entry,
          ticket: Number.isSafeInteger(ticket) && ticket > 0 ? ticket : null,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (fs.existsSync(path.join(locks, entry))) claims.push({ id: entry, ticket: null });
      }
    }
    return claims;
  };
  try {
    // A published claim without a ticket means "choosing". All contenders wait
    // for it before comparing tickets, closing the simultaneous-start race.
    // https://github.com/Brevilabs/obsidian-copilot-private/issues/537
    const ticket = Math.max(0, ...(await readClaims()).map((c) => c.ticket ?? 0)) + 1;
    await fs.promises.writeFile(path.join(claim, "ticket.tmp"), String(ticket));
    await fs.promises.rename(path.join(claim, "ticket.tmp"), path.join(claim, "ticket"));
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (
      (await readClaims()).some(
        (c) =>
          c.id !== id &&
          (c.ticket === null || c.ticket < ticket || (c.ticket === ticket && c.id < id))
      )
    ) {
      if (Date.now() >= deadline) throw new Error(`Managed runtime is locked (${ISSUE}).`);
      await new Promise((resolve) =>
        requireNodeModule<typeof import("node:timers")>("timers").setTimeout(resolve, 50)
      );
    }
    return await body();
  } finally {
    await fs.promises.rm(claim, { recursive: true, force: true });
  }
}

/**
 * Removes verified older installations while retaining every process-referenced tree.
 * Callers hold the root's runtime lock; old plugins do not participate in that protocol.
 * @param root - Backend-owned installation root.
 * @param selected - Current settings, read inside the runtime lock.
 * @param isInstalled - Backend-specific validation of a completed installation.
 */
export async function pruneManagedRuntimes(
  root: string,
  selected: BinarySettings,
  isInstalled: (directory: string, version: string) => Promise<boolean>
): Promise<void> {
  const fs = requireNodeModule<typeof import("node:fs")>("fs");
  const path = requireNodeModule<typeof import("node:path")>("path");
  // Custom selections and missing runtimes cannot authorize deleting the fallback.
  // https://github.com/Brevilabs/obsidian-copilot-private/issues/537
  if (selected.binarySource !== "managed" || !selected.binaryPath || !selected.binaryVersion)
    return;
  try {
    const realRoot = await fs.promises.realpath(root);
    const realSelected = await fs.promises.realpath(selected.binaryPath);
    const within = (parent: string, child: string): boolean => {
      const rel = path.relative(parent, child);
      return (
        rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))
      );
    };
    if (!within(realRoot, realSelected) || (await fs.promises.lstat(root)).isSymbolicLink()) return;
    const candidates: string[] = [];
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      const version = /^(\d+\.\d+\.\d+(?:-r\d+)?)(?:-[0-9a-f]{8}-[0-9a-f-]{27})?$/.exec(
        entry.name
      )?.[1];
      // Equal/newer pins belong to other plugin releases. Unknown entries, symlinks
      // and staging trees are never ours to prune. See the issue above.
      if (!entry.isDirectory() || !version || compareSemver(version, selected.binaryVersion) >= 0)
        continue;
      const directory = path.join(root, entry.name);
      if (
        !within(await fs.promises.realpath(directory), realSelected) &&
        (await isInstalled(directory, version))
      )
        candidates.push(directory);
    }
    if (!candidates.length) return;
    const commands = await runningCommands();
    for (const directory of candidates) {
      const prefixes = [directory, await fs.promises.realpath(directory)].map((dir) =>
        `${dir}${path.sep}`.toLowerCase()
      );
      // The adapter may launch bundled children after the update; retain its entire
      // installation, including for processes launched by an older plugin. See ISSUE.
      if (
        commands.some((command) =>
          prefixes.some((prefix) => command.toLowerCase().includes(prefix))
        )
      )
        continue;
      await fs.promises.rm(directory, { recursive: true, force: true }).catch((error) => {
        logWarn(`[AgentMode] Could not reclaim an older runtime: ${error}`);
      });
    }
  } catch (error) {
    logWarn(`[AgentMode] Runtime cleanup deferred: ${error}`);
  }
}

async function runningCommands(): Promise<string[]> {
  const fs = requireNodeModule<typeof import("node:fs")>("fs");
  const { execFile } = requireNodeModule<typeof import("node:child_process")>("child_process");
  const run = (command: string, args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        command,
        args,
        { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
        (error, result) => (error ? reject(error) : resolve(result))
      );
    });
  // argv can name a symlink outside the managed tree. Inspect kernel-resolved
  // executable/cwd paths as well, preserving bundled files the process may reopen.
  // https://github.com/Brevilabs/obsidian-copilot-private/issues/537
  if (process.platform === "linux") {
    const commands: string[] = [];
    for (const pid of await fs.promises.readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const directory = `/proc/${pid}`;
        if ((await fs.promises.stat(directory)).uid !== process.getuid()) continue;
        const [exe, cwd, args] = await Promise.all([
          fs.promises.readlink(`${directory}/exe`),
          fs.promises.readlink(`${directory}/cwd`),
          fs.promises.readFile(`${directory}/cmdline`, "utf8"),
        ]);
        commands.push(exe, `${cwd}/`, args.replace(/\0/g, " "));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!commands.length) throw new Error("Process inventory was empty.");
    return commands;
  }
  if (process.platform === "darwin") {
    const [commands, files] = await Promise.all([
      run("ps", ["-ww", "-axo", "command="]),
      run("lsof", ["-nP", "-a", "-u", String(process.getuid()), "-d", "txt,cwd", "-Fn"]),
    ]);
    if (!commands.trim() || !files.split("\n").some((line) => line.startsWith("n")))
      throw new Error("Process inventory was incomplete.");
    return [
      ...commands.split("\n"),
      ...files
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => `${line.slice(1)}/`),
    ];
  }
  if (process.platform !== "win32") throw new Error("Process inventory is unsupported.");
  const stdout = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    // Enumerate the current SID across sessions. Kernel PIDs have no user-mode
    // executable; an unknown owner anywhere else makes reclamation unsafe.
    // https://github.com/Brevilabs/obsidian-copilot-private/issues/537
    `$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$processes=Get-CimInstance Win32_Process
$rows=@(foreach($p in $processes) {
  if($p.ProcessId -eq 0 -or $p.ProcessId -eq 4) { continue }
  $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
  if($owner.ReturnValue -ne 0) { throw 'Process owner unavailable' }
  if($owner.Sid -eq $sid) { $p | Select-Object ProcessId,CommandLine,ExecutablePath }
})
ConvertTo-Json -InputObject $rows -Compress`,
  ]);
  const rows = JSON.parse(stdout) as {
    ProcessId?: number;
    CommandLine?: string;
    ExecutablePath?: string;
  }[];
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.some((row) => row.ProcessId === undefined || !row.CommandLine || !row.ExecutablePath)
  )
    throw new Error("Invalid process inventory.");
  return rows.map((row) => `${row.ExecutablePath ?? ""} ${row.CommandLine ?? ""}`);
}
