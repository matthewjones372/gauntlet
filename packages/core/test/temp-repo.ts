import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
}

/** A throwaway git repository for tests, driven synchronously. */
export class TempRepo {
  readonly dir: string

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "gauntlet-repo-"))
    this.git("init", "-q", "-b", "main")
    this.git("config", "commit.gpgsign", "false")
  }

  git(...args: string[]): string {
    const r = Bun.spawnSync(["git", ...args], { cwd: this.dir, env: ENV })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }

  write(files: Record<string, string>): this {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, path)), { recursive: true })
      writeFileSync(join(this.dir, path), content)
    }
    return this
  }

  remove(...paths: string[]): this {
    for (const p of paths) rmSync(join(this.dir, p), { force: true })
    return this
  }

  symlink(target: string, path: string): this {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true })
    symlinkSync(target, join(this.dir, path))
    return this
  }

  /** Stage everything and commit; returns the new commit's sha. */
  commit(message = "change"): string {
    this.git("add", "-A")
    this.git("commit", "-q", "--allow-empty", "-m", message)
    return this.git("rev-parse", "HEAD")
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}
