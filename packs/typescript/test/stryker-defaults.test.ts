import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { strykerDefaults } from "../src/gates.ts"

// Mutation testing needs no Stryker config: Gauntlet uses the project's own test runner.

const chain = (runner: "vitest" | "jest" | "bun" | undefined, deps: string[] = []) =>
  ({ manager: "bun", runner: runner ? Option.some(runner) : Option.none(), deps: new Set(["@stryker-mutator/core", ...deps]) }) as never

describe("Stryker without a config file", () => {
  test("bun test needs no plugin: Stryker's command runner runs it", () => {
    expect(strykerDefaults(chain("bun"), ["src/a.ts"])).toMatchObject({ testRunner: "command", commandRunner: { command: "bun test" }, coverageAnalysis: "off" })
  })

  test("Vitest and Jest use their plugins, and say so when they're missing", () => {
    expect(strykerDefaults(chain("vitest", ["@stryker-mutator/vitest-runner"]), ["src/a.ts"])).toMatchObject({ testRunner: "vitest", coverageAnalysis: "perTest" })
    expect(strykerDefaults(chain("jest"), ["src/a.ts"])).toBe("Stryker needs its Jest plugin: add @stryker-mutator/jest-runner")
  })

  test("main sources are mutated, tests never", () => {
    const d = strykerDefaults(chain("bun"), ["src/a.ts"]) as { mutate: string[] }
    expect(d.mutate[0]).toBe("src/**/*.{ts,tsx,js,jsx,mts,cts}")
    expect(d.mutate).toContain("!**/*.{test,spec}.*")
    expect((strykerDefaults(chain("bun"), ["lib/a.ts"]) as { mutate: string[] }).mutate).toContain("!node_modules/**")
  })

  test("no test runner: says what to add", () => {
    expect(strykerDefaults(chain(undefined), [])).toBe("no test runner found for Stryker: add vitest or jest, or use bun test")
  })
})
