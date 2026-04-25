// Single-writer election for spool drain + rollout reconcile + retention.
// When multiple agent-monitor TUIs run side-by-side they'd otherwise compete
// to drain the same spool files and write the same events to the same SQLite
// DB. We arbitrate by atomically creating ~/.local/state/agent-monitor/indexer.lock
// with O_EXCL; the winner does writes, the others run read-only.
//
// We don't use flock(2) because Node doesn't expose it without ffi/native.
// O_EXCL + PID-file is good enough: stale locks (writer crashed) are detected
// by `kill(pid, 0)` returning ESRCH, and we transparently take over.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.ts';

const lockPath = path.join(PATHS.state, 'indexer.lock');
let heldFd: number | null = null;

// Extra safety against PID reuse: kill(pid, 0) succeeds for ANY live process
// with that PID, including unrelated programs the kernel reused the slot for.
// We additionally verify the cmdline mentions our entry path so we don't keep
// deferring to e.g. a long-lived `vim` that landed on the previous writer's PID.
function processIsOurs(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    // Match: contains src/cli.ts (the TUI entry) or the installed bin name.
    return cmdline.includes('src/cli.ts') || cmdline.includes('agent-monitor');
  } catch {
    // /proc unreadable; conservatively treat as ours (don't steal).
    return true;
  }
}

// Try to atomically claim writer. Returns true if THIS process is now the
// writer (either freshly acquired or already held). Idempotent.
export function tryAcquireWriter(): boolean {
  if (heldFd !== null) return true;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx'); // O_WRONLY | O_CREAT | O_EXCL
      writeSync(fd, String(process.pid));
      heldFd = fd;
      return true;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') return false;
    }
    // File exists. Reap if stale.
    try {
      const raw = readFileSync(lockPath, 'utf-8').trim();
      const heldBy = parseInt(raw, 10);
      if (processIsOurs(heldBy)) return false;
      // Stale lock — owner is gone. Remove and retry once.
      try {
        unlinkSync(lockPath);
      } catch {}
      // Loop iterates, retries the create.
    } catch {
      return false;
    }
  }
  return false;
}

// Returns 'this' if WE hold the lock, 'other' if some other live process
// holds it, 'none' if the lock file is missing.
export function getWriterStatus(): 'this' | 'other' | 'none' {
  if (heldFd !== null) return 'this';
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    const heldBy = parseInt(raw, 10);
    if (processIsOurs(heldBy)) return 'other';
    return 'none';
  } catch {
    return 'none';
  }
}

// Release the lock. Idempotent. Best to call on graceful shutdown.
export function releaseWriter(): void {
  if (heldFd === null) return;
  try {
    closeSync(heldFd);
  } catch {}
  try {
    unlinkSync(lockPath);
  } catch {}
  heldFd = null;
}

// Best-effort: ensure we release on process exit even without explicit call.
// Keeps stale locks rare across hard kills (Ctrl-C is handled by ink).
process.on('exit', releaseWriter);
process.on('SIGINT', () => {
  releaseWriter();
  // SIGINT default handler will run after this if not explicitly stopped;
  // ink also installs its own handler so this is just defense in depth.
});
