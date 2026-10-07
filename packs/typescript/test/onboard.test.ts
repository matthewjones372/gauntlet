import { describe, expect, test } from "bun:test"
import { onboard } from "../src/onboard.ts"

const view = (files: Record<string, string>) => ({ files: Object.keys(files).sort(), read: (p: string) => files[p] })
const pkg = (devDependencies: Record<string, string>) => JSON.stringify({ devDependencies })

describe("typescript onboarding", () => {
  test("every gate whose tool is installed", () => {
    const o = onboard(view({
      "package.json": pkg({ vitest: "4", "@vitest/coverage-v8": "4", "@biomejs/biome": "2", "@stryker-mutator/core": "9" }),
      "tsconfig.json": "{}", "biome.json": "{}", "vitest.config.ts": "", "src/a.ts": "", "test/a.test.ts": "",
    }))
    expect(o.fast).toEqual(["build", "lint ratchet"])
    expect(o.verify).toEqual(["coverage ratchet on changed", "mutation ratchet on changed"])
    expect(o.setup).toEqual([])
    expect(o.protect.tests).toEqual(["test/**"])
    expect(o.protect.config).toEqual(["biome.json", "tsconfig.json", "vitest.config.ts"])
    expect(o.suites).toEqual([{ name: "unit", location: "test/**" }])
  })

  test("missing tools become setup hints; vitest without a coverage provider can't gate coverage", () => {
    const o = onboard(view({ "package.json": pkg({ vitest: "4" }), "src/a.ts": "", "src/a.test.ts": "" }))
    expect(o.fast).toEqual([])
    expect(o.verify).toEqual([])
    expect(o.setup).toContain("Add @vitest/coverage-v8 to gate coverage.")
    expect(o.setup).toContain("Add a tsconfig.json at the repository root to gate type checking (build).")
    expect(o.protect.tests).toEqual(["**/*.test.*", "**/*.spec.*"])
  })

  test("bun test needs no extra coverage tool, and with no test runner there are no suites", () => {
    expect(onboard(view({ "package.json": pkg({}), "bun.lock": "", "tsconfig.json": "{}", "test/a.test.ts": "" })).verify).toEqual(["coverage ratchet on changed"])
    expect(onboard(view({ "package.json": pkg({}), "package-lock.json": "", "test/a.test.ts": "" })).suites).toEqual([])
  })
})
