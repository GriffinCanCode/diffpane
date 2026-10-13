import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type ProcessSample = { pid: number; parent: number; rssBytes: number; command: string };

/** Include renderer/GPU/utility processes, worker isolates, Git, and language servers. */
export function descendants(source: string, rootPid: number): ProcessSample[] {
  const processes = source
    .trim()
    .split('\n')
    .flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match
        ? [{ pid: +match[1], parent: +match[2], rssBytes: +match[3] * 1024, command: match[4] }]
        : [];
    });
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (owned.has(process.parent) && !owned.has(process.pid)) {
        owned.add(process.pid);
        changed = true;
      }
    }
  }
  return processes.filter(process => owned.has(process.pid));
}

export async function sampleMemory(rootPid: number) {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('Whole-process RSS measurement requires macOS or Linux.');
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,comm='], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const processes = descendants(stdout, rootPid);
  if (!processes.some(process => process.pid === rootPid))
    throw new Error('The app process exited.');
  return {
    at: Date.now(),
    rssBytes: processes.reduce((sum, process) => sum + process.rssBytes, 0),
    processes,
  };
}
