import { describe, expect, test } from "bun:test"
import { explainPolicy } from "../src/index.ts"
import { compiled } from "./fixtures.ts"

// Spec 0012: `gauntlet explain` says what the scenarios check holds a change to.

const policy = (check: string) => compiled(`gauntlet "x"\nuse jvm\nowners @p\nsuites { unit "src/test/**" }\nscenarios "specs/**/*.feature"\ngates { verify { unit }\n behaviour { ${check} } }\n`).ir

describe("explain with scenarios", () => {
  test("the check, blocking or advising, and the scenario files' protection", () => {
    expect(explainPolicy(policy("scenarios"), "gates")).toContain("- behaviour: every scenario's tests ran, passed, can fail and catch a bug on the changed lines")
    expect(explainPolicy(policy("scenarios advise"), "gates")).toContain("catch a bug on the changed lines (verdicts reported, never blocking)")
    expect(explainPolicy(policy("scenarios"), "protect")).toContain("- scenarios: specs/**/*.feature")
  })
})
