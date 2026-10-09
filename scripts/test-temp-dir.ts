import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

// Every test run gets one temporary directory, and everything the tests make
// in the temporary directory (theirs, Gauntlet's, the tools' they start) goes
// inside it. It is removed when the run ends. A run that was killed before it
// could clean up is removed by the next run, once its process is gone.

export const RUN_PREFIX = "gauntlet-test-run-"

/** Whether a process is still running (one owned by someone else counts). */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw e
  }
}

/** Removes the directories of earlier runs whose process is gone; returns their names. */
export const sweepDeadRuns = (root: string, isAlive: (pid: number) => boolean = alive): ReadonlyArray<string> => {
  const dead = readdirSync(root).filter((name) => {
    const pid = Number(name.slice(RUN_PREFIX.length).split("-")[0])
    return name.startsWith(RUN_PREFIX) && Number.isInteger(pid) && pid > 0 && !isAlive(pid)
  })
  for (const name of dead) rmSync(join(root, name), { recursive: true, force: true })
  return dead
}

/** This run's directory, named after its process. */
export const startRun = (root: string, pid: number = process.pid): string => mkdtempSync(join(root, `${RUN_PREFIX}${pid}-`))

/**
 * Points the temporary directory at a new directory for this run, after
 * removing dead runs', and registers its removal for when the run ends.
 */
export const isolateRun = (root: string, atEnd: (cleanup: () => void) => void): string => {
  sweepDeadRuns(root)
  const dir = startRun(root)
  process.env.TMPDIR = dir
  atEnd(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
