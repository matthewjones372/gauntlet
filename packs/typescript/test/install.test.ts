import { describe, expect, test } from "bun:test"
import { onboard } from "../src/onboard.ts"

// What `gauntlet setup` offers to install for a TypeScript project.

const view = (files: Record<string, string>) => ({ files: Object.keys(files).sort(), read: (p: string) => files[p] })
const pkg = (devDependencies: Record<string, string>) => JSON.stringify({ devDependencies })

describe("typescript install offer", () => {
  test("the missing tools, with the project's own package manager", () => {
    expect(onboard(view({ "package.json": pkg({ vitest: "4" }), "pnpm-lock.yaml": "", "src/a.ts": "" })).install)
      .toEqual([["pnpm", "add", "-D", "@biomejs/biome", "@vitest/coverage-v8", "@stryker-mutator/core", "@stryker-mutator/vitest-runner"]])
    expect(onboard(view({ "package.json": pkg({ jest: "30", eslint: "9", "@stryker-mutator/core": "9" }), "src/a.ts": "" })).install).toBeUndefined()
    expect(onboard(view({ "package.json": pkg({}), "bun.lock": "", "src/a.ts": "" })).install).toEqual([["bun", "add", "-d", "@biomejs/biome", "@stryker-mutator/core"]])
  })

  test("never picks a test runner for the project", () => {
    const o = onboard(view({ "package.json": pkg({ eslint: "9" }), "package-lock.json": "", "src/a.ts": "" }))
    expect(o.install).toBeUndefined()
    expect(o.setup).toContain("Add vitest or jest (or use bun test) to run tests and gate coverage.")
  })
})
