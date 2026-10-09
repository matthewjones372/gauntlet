import { describe, expect, test } from "bun:test"
import { toolchainSteps } from "../src/index.ts"
import { compiled } from "../../core/test/fixtures.ts"

// ADR 0022: with builds in folders, each build's own files say which tools
// the workflow sets up, as the root's would for one build.

describe("toolchain steps for builds in folders", () => {
  test("a Bun lockfile in a build's folder sets up Bun, as it would at the root", () => {
    const ir = compiled(`gauntlet "x"\nuse jvm in "api"\nowners @p\ngates { fast { build } }\n`).ir
    const withBun = { ...ir, packs: ["typescript"], builds: [{ pack: "typescript", dir: "web" }] }
    const steps = toolchainSteps({ mode: "repo", ir: withBun, files: ["web/bun.lock", "web/src/a.ts"], gauntletVersion: "0", downloadUrl: "x", fromSource: false } as never)
    expect(steps.join("\n")).toContain("Set up Bun")
    expect(toolchainSteps({ mode: "repo", ir: withBun, files: ["web/package-lock.json"], gauntletVersion: "0", downloadUrl: "x", fromSource: false } as never).join("\n")).toContain("Set up Node")
  })
})
