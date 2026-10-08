import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// install.sh picks the highest version, not whatever GitHub lists first (its
// order lags just after a release). A fake curl stands in for GitHub.

const ROOT = join(import.meta.dir, "..", "..", "..")
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const chosen = (tags: string[]) => {
  const bin = mkdtempSync(join(tmpdir(), "gauntlet-fake-curl-"))
  dirs.push(bin)
  const json = JSON.stringify(tags.map((t) => ({ tag_name: t, prerelease: t.includes("-") })))
  // Release lists come back as JSON; downloads fail, which stops the script after it has chosen.
  writeFileSync(join(bin, "curl"), `#!/bin/sh\ncase "$*" in *"/releases?per_page="*) printf '%s\\n' '${json}' | sed 's/},{/},\\n{/g' ;; *) exit 22 ;; esac\n`, { mode: 0o755 })
  const r = Bun.spawnSync(["sh", join(ROOT, "install.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GAUNTLET_INSTALL_DIR: bin } })
  return `${r.stdout.toString()}${r.stderr.toString()}`.match(/releases\/download\/(v[^\s/]+)/)?.[1]
}

describe("install.sh", () => {
  test("rc.10 beats rc.9, whatever order GitHub lists them in", () => {
    expect(chosen(["v0.1.0-rc.9", "v0.1.0-rc.8", "v0.1.0-rc.10"])).toBe("v0.1.0-rc.10")
  })

  test("a final release beats its release candidates, and a newer minor beats both", () => {
    expect(chosen(["v0.1.0-rc.10", "v0.1.0"])).toBe("v0.1.0")
    expect(chosen(["v0.1.0", "v0.2.0-rc.1", "v0.1.1"])).toBe("v0.2.0-rc.1")
  })
})
