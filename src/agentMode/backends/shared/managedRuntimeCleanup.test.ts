import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import childProcess from "node:child_process";
import { once } from "node:events";
import { pruneManagedRuntimes, withManagedRuntimeLock } from "./managedRuntimeCleanup";

jest.mock("@/logger", () => ({ logWarn: jest.fn() }));
const ISSUE = "https://github.com/Brevilabs/obsidian-copilot-private/issues/537";

describe("managedRuntimeCleanup", () => {
  let root: string;
  const installed = async (directory: string) => fs.existsSync(path.join(directory, "installed"));
  const make = (version: string) => {
    const dir = path.join(root, version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "installed"), "verified installation");
    return dir;
  };
  const selection = () => ({
    binarySource: "managed" as const,
    binaryPath: path.join(root, "2.0.0", "installed"),
    binaryVersion: "2.0.0",
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cleanup-"));
    make("2.0.0");
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}.runtime-locks`, { recursive: true, force: true });
  });

  describe("pruneManagedRuntimes()", () => {
    it(`reclaims all verified lower versions but keeps equal, higher and unknown entries: ${ISSUE}`, async () => {
      make("1.0.0");
      make("1.5.0-12345678-1234-1234-1234-123456789012");
      make("2.0.0-12345678-1234-1234-1234-123456789012");
      make("3.0.0");
      make(".tmp-1.0.0");
      fs.mkdirSync(path.join(root, "0.5.0"));
      await pruneManagedRuntimes(root, selection(), installed);
      expect(fs.readdirSync(root).sort()).toEqual([
        ".tmp-1.0.0",
        "0.5.0",
        "2.0.0",
        "2.0.0-12345678-1234-1234-1234-123456789012",
        "3.0.0",
      ]);
    });
    it(`retains a legacy real child runtime until its process exits: ${ISSUE}`, async () => {
      const old = make("1.0.0");
      const child = childProcess.spawn(process.execPath, [
        "-e",
        "process.stdout.write('ready'); setInterval(() => {}, 1000)",
        path.join(old, "installed"),
      ]);
      await once(child.stdout, "data");
      try {
        await pruneManagedRuntimes(root, selection(), installed);
        expect(fs.existsSync(old)).toBe(true);
      } finally {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await pruneManagedRuntimes(root, selection(), installed);
      expect(fs.existsSync(old)).toBe(false);
    });
    it(`retains a real executable launched through an alias outside its installation: ${ISSUE}`, async () => {
      if (process.platform === "win32") return;
      const old = make("1.0.0");
      const executable = path.join(old, "sleep");
      childProcess.execFileSync("cc", ["-x", "c", "-o", executable, "-"], {
        input: "#include <unistd.h>\nint main(void) { sleep(30); return 0; }\n",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const alias = path.join(root, "runtime-alias");
      fs.symlinkSync(executable, alias);
      const child = childProcess.spawn(alias, ["30"]);
      const exited = once(child, "exit");
      await once(child, "spawn");
      try {
        await pruneManagedRuntimes(root, selection(), installed);
        expect(fs.existsSync(old)).toBe(true);
      } finally {
        child.kill();
        await exited;
      }
      await pruneManagedRuntimes(root, selection(), installed);
      expect(fs.existsSync(old)).toBe(false);
    });
    it(`preserves the selected lower directory and symlink entries: ${ISSUE}`, async () => {
      const old = make("1.0.0");
      fs.symlinkSync(old, path.join(root, "0.5.0"), "dir");
      await pruneManagedRuntimes(
        root,
        { ...selection(), binaryPath: path.join(old, "installed") },
        installed
      );
      expect(fs.existsSync(old)).toBe(true);
      expect(fs.lstatSync(path.join(root, "0.5.0")).isSymbolicLink()).toBe(true);
    });
    it(`retains downloads for custom or missing managed selections: ${ISSUE}`, async () => {
      make("1.0.0");
      await pruneManagedRuntimes(root, { ...selection(), binarySource: "custom" }, installed);
      await pruneManagedRuntimes(
        root,
        { ...selection(), binaryPath: path.join(root, "missing") },
        installed
      );
      expect(fs.existsSync(path.join(root, "1.0.0"))).toBe(true);
    });
    it(`defers deletion when process inspection fails: ${ISSUE}`, async () => {
      make("1.0.0");
      jest.spyOn(childProcess, "execFile").mockImplementation(((
        _c: unknown,
        _a: unknown,
        _o: unknown,
        cb: (e: Error) => void
      ) => {
        cb(new Error("inspection denied"));
      }) as never);
      await pruneManagedRuntimes(root, selection(), installed);
      expect(fs.existsSync(path.join(root, "1.0.0"))).toBe(true);
    });
  });

  describe("withManagedRuntimeLock()", () => {
    it(`serializes simultaneous and late contenders without overlapping bodies: ${ISSUE}`, async () => {
      let active = 0;
      let peak = 0;
      const jobs = Array.from({ length: 8 }, () =>
        withManagedRuntimeLock(root, async () => {
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => window.setTimeout(resolve, 10));
          active--;
        })
      );
      await Promise.all(jobs);
      expect(peak).toBe(1);
      expect(fs.readdirSync(`${root}.runtime-locks`)).toEqual([]);
    });
    it(`waits for both concurrent ticket choices before entering either body: ${ISSUE}`, async () => {
      const rename = fs.promises.rename.bind(fs.promises);
      let choices = 0;
      let release!: () => void;
      const choosing = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        if (++choices === 2) release();
        await choosing;
        return rename(from, to);
      });
      let active = 0;
      let peak = 0;
      await Promise.all(
        [0, 1].map(() =>
          withManagedRuntimeLock(root, async () => {
            peak = Math.max(peak, ++active);
            await new Promise((resolve) => window.setTimeout(resolve, 10));
            active--;
          })
        )
      );
      expect(choices).toBe(2);
      expect(peak).toBe(1);
    });
    it(`retains an unreadable owner claim and refuses unsafe entry: ${ISSUE}`, async () => {
      const foreign = path.join(`${root}.runtime-locks`, `${process.pid}-foreign`);
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, "ticket"), "partial");
      let now = 0;
      jest.spyOn(Date, "now").mockImplementation(() => (now += 10_001));
      const body = jest.fn();
      await expect(withManagedRuntimeLock(root, body)).rejects.toThrow("locked");
      expect(body).not.toHaveBeenCalled();
      expect(fs.existsSync(foreign)).toBe(true);
    });
    it(`blocks behind a real other process and recovers its claim after a crash: ${ISSUE}`, async () => {
      const stub = path.join(root, "node-runtime.cjs");
      const bundle = path.join(root, "cleanup.cjs");
      fs.writeFileSync(stub, "exports.requireNodeModule = require; exports.logWarn = () => {};");
      childProcess.execFileSync(process.execPath, [
        "-e",
        "require('esbuild').buildSync(JSON.parse(process.argv[1]))",
        JSON.stringify({
          entryPoints: [path.resolve("src/agentMode/backends/shared/managedRuntimeCleanup.ts")],
          outfile: bundle,
          bundle: true,
          platform: "node",
          format: "cjs",
          alias: { "@/utils/desktopRuntime": stub, "@/logger": stub },
        }),
      ]);
      const child = childProcess.spawn(process.execPath, [
        "-e",
        "require(process.argv[1]).withManagedRuntimeLock(process.argv[2], async () => { process.stdout.write('held'); await new Promise(() => {}); }); setInterval(() => {}, 1000)",
        bundle,
        root,
      ]);
      await once(child.stdout, "data");
      let entered = false;
      const waiting = withManagedRuntimeLock(root, async () => {
        entered = true;
      });
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      expect(entered).toBe(false);
      const exited = once(child, "exit");
      child.kill();
      await exited;
      await waiting;
      expect(entered).toBe(true);
      expect(fs.readdirSync(`${root}.runtime-locks`)).toEqual([]);
    });
    it(`reclaims a dead process's unique claim without stealing live claims: ${ISSUE}`, async () => {
      const child = childProcess.spawn(process.execPath, ["-e", "process.stdout.write('ready')"]);
      await once(child, "exit");
      const abandoned = path.join(`${root}.runtime-locks`, `${child.pid}-abandoned`);
      fs.mkdirSync(abandoned, { recursive: true });
      fs.writeFileSync(path.join(abandoned, "ticket"), "1");
      await expect(withManagedRuntimeLock(root, async () => "recovered")).resolves.toBe(
        "recovered"
      );
      expect(fs.existsSync(abandoned)).toBe(false);
    });
    it(`removes only its own claim when a body fails: ${ISSUE}`, async () => {
      await expect(
        withManagedRuntimeLock(root, async () => {
          throw new Error("cancelled");
        })
      ).rejects.toThrow("cancelled");
      expect(fs.readdirSync(`${root}.runtime-locks`)).toEqual([]);
      await expect(withManagedRuntimeLock(root, async () => 42)).resolves.toBe(42);
    });
    it(`does not publish a partial ticket after a write failure: ${ISSUE}`, async () => {
      const write = jest
        .spyOn(fs.promises, "writeFile")
        .mockRejectedValueOnce(new Error("disk full"));
      await expect(withManagedRuntimeLock(root, async () => "unsafe")).rejects.toThrow("disk full");
      expect(fs.readdirSync(`${root}.runtime-locks`)).toEqual([]);
      write.mockRestore();
    });
  });
});
