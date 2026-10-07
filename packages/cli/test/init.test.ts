import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expectGolden } from "../../core/test/golden-file.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

const FIXTURES = join(import.meta.dir, "..", "..", "..", "examples", "fixtures")
const repos: TempRepo[] = []
const dirs: string[] = []
afterEach(() => {
  repos.splice(0).forEach((r) => r.cleanup())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

/** A fixture project as it was before Gauntlet: no policy. */
const project = (name: string) => {
  const r = new TempRepo()
  repos.push(r)
  cpSync(join(FIXTURES, name), r.dir, { recursive: true, filter: (src) => !/\/(build|\.gradle|\.kotlin|node_modules|\.gauntlet|\.venv)(\/|$)/.test(src) })
  r.commit("project")
  return r
}
const gauntlet = (args: string[]) => cli(args, [...INSTALLED_PACKS])

describe("gauntlet init", () => {
  for (const fixture of ["kotlin-service", "ts-service", "py-service"]) {
    test(`drafts a valid shadow-mode policy for ${fixture}`, async () => {
      const r = project(fixture)
      const res = await gauntlet(["init", "--repo", r.dir, "--name", fixture, "--owner", "@platform"])
      expect(res.code).toBe(0)
      expect(res.err).toContain("--template")
      const policy = readFileSync(join(r.dir, ".gauntlet", "policy.gx"), "utf8")
      expectGolden(join(import.meta.dir, "golden", `init-${fixture}.gx`), policy)
      const validated = await gauntlet(["validate", "--repo", r.dir])
      expect(validated.code).toBe(0)
      expect(res.out).toContain("gauntlet baseline")
    })
  }

  test("lists the gates it left out and what to add", async () => {
    const r = project("ts-service")
    const pkg = JSON.parse(readFileSync(join(r.dir, "package.json"), "utf8"))
    delete pkg.devDependencies["@stryker-mutator/core"]
    r.write({ "package.json": JSON.stringify(pkg) })
    r.commit("no stryker")
    const res = await gauntlet(["init", "--repo", r.dir, "--template", "--dry-run"])
    expect(res.out).not.toContain("mutation ratchet")
    expect(res.out).toContain("Add @stryker-mutator/core")
    expect(existsSync(join(r.dir, ".gauntlet", "policy.gx"))).toBe(false)
  })

  test("never replaces a policy without --force", async () => {
    const r = project("py-service")
    r.write({ ".gauntlet/policy.gx": "mine\n" })
    const res = await gauntlet(["init", "--repo", r.dir])
    expect(res.code).toBe(2)
    expect(res.err).toContain("already exists")
    expect(readFileSync(join(r.dir, ".gauntlet", "policy.gx"), "utf8")).toBe("mine\n")
    expect((await gauntlet(["init", "--repo", r.dir, "--force"])).code).toBe(0)
    expect(readFileSync(join(r.dir, ".gauntlet", "policy.gx"), "utf8")).toContain("use python")
  })

  test("needs a git repository and a project a pack recognises", async () => {
    const plain = mkdtempSync(join(tmpdir(), "gauntlet-plain-"))
    dirs.push(plain)
    expect((await gauntlet(["init", "--repo", plain])).err).toContain("isn't a git repository")
    const r = new TempRepo()
    repos.push(r)
    r.write({ "notes.txt": "hello\n" })
    r.commit("notes")
    const res = await gauntlet(["init", "--repo", r.dir])
    expect(res.code).toBe(2)
    expect(res.err).toContain("No supported project found here. Installed packs: jvm")
  })
})

describe("gauntlet new", () => {
  const target = () => {
    const parent = mkdtempSync(join(tmpdir(), "gauntlet-new-"))
    dirs.push(parent)
    return join(parent, "payments-api")
  }

  test("creates a git repository with the template, in enforce mode", async () => {
    const dir = target()
    const res = await gauntlet(["new", "kotlin-service", dir, "--owner", "@acme/payments", "--package", "com.acme.payments"])
    expect(res.code).toBe(0)
    expect(res.out).toContain("mode enforce")
    expect(existsSync(join(dir, ".git"))).toBe(true)
    expect(statSync(join(dir, "gradlew")).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(dir, "src/main/kotlin/com/acme/payments/domain/Money.kt"), "utf8")).toStartWith("package com.acme.payments.domain")
    const validated = await gauntlet(["validate", "--repo", dir])
    expect(validated.out).toContain("is valid")
  })

  test("says when the owner is the placeholder", async () => {
    const res = await gauntlet(["new", "kotlin-service", target(), "--no-git"])
    expect(res.out).toContain("change `owners` in .gauntlet/policy.gx")
  })

  test("refuses a non-empty directory, an unknown template and bad values", async () => {
    const dir = target()
    await gauntlet(["new", "kotlin-service", dir, "--no-git"])
    writeFileSync(join(dir, "keep.txt"), "x")
    expect((await gauntlet(["new", "kotlin-service", dir])).err).toContain("isn't empty")
    expect((await gauntlet(["new", "rails-app", target()])).err).toContain("Unknown template 'rails-app'. Available: kotlin-service")
    const bad = await gauntlet(["new", "kotlin-service", target(), "--package", "Com.Acme"])
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("package 'Com.Acme'")
  })
})
