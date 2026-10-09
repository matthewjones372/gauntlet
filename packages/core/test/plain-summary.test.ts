import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { plainSummary, type Report } from "../src/index.ts"

// The report starts in plain words and in colour (a GitHub alert): what
// Gauntlet decided and why, what the change is, and what to look at.

const golden = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "golden", `${name}.report.json`), "utf8")) as Report

describe("the report's summary", () => {
  test("an owner's approval: the zone with its owner and files, and each protected file", () => {
    const text = plainSummary(golden("owner-policy-edit")).join("\n")
    expect(text).toStartWith("> [!WARNING]\n> **Needs careful review by an owner (@payments, @platform)** because it touches the money zone")
    expect(text).toContain("> 3 things to look at:")
    expect(text).toContain("> 1. It changes code in the **money** zone (owner @payments): `src/main/money/Fx.kt`.")
    expect(text).not.toContain("The policy's")
  })

  test("a blocked change: what to fix first, then what to look at", () => {
    const text = plainSummary(golden("failing-enforce")).join("\n")
    expect(text).toStartWith("> [!CAUTION]\n> **Blocked** because ")
    expect(text).toMatch(/\d+ things to fix, and \d+ more things? to look at:/)
    expect(text).toContain("No rule in the policy says a change like this can merge on its own")
  })

  test("a change that can merge: one line, nothing to look at", () => {
    expect(plainSummary(golden("clean-auto")).filter(Boolean)).toEqual(["> [!TIP]", "> **Low-risk change**: it can merge without anyone's approval. It changes 1 file (12 lines)."])
  })
})
