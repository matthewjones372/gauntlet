import { describe, expect, test } from "bun:test"
import { convertJUnit } from "@gauntlet/sarif"
import { Effect, Exit } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { runSuite } from "../src/gates.ts"

// A bun test is named after its file (ADR 0027), so two files' tests with the
// same describe path and name are two tests, and selection can tell whose file a test is.

const SUITE = { name: "unit", location: "test/**" }

const TWO_FILES = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="2" failures="0" skipped="0" time="0.01">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="1">
    <testsuite name="money" file="test/a.test.ts" line="2" tests="1">
      <testcase name="adds" classname="money" time="0" file="test/a.test.ts" line="3" assertions="1" />
    </testsuite>
  </testsuite>
  <testsuite name="test/b.test.ts" file="test/b.test.ts" tests="1">
    <testsuite name="money" file="test/b.test.ts" line="2" tests="1">
      <testcase name="adds" classname="money" time="0" file="test/b.test.ts" line="3" assertions="1" />
    </testsuite>
  </testsuite>
</testsuites>`

describe("bun's test ids in the TypeScript pack", () => {
  test("the suite's tests are named after their files", async () => {
    const g = fakeGate({ "package.json": "{}", "bun.lock": "", "test/a.test.ts": "", "test/b.test.ts": "" })
    writeFileSync(join(g.ctx.outputDir, "junit.xml"), TWO_FILES)
    const r = await g.run(runSuite(SUITE, g.ctx))
    expect(r.tests?.ids).toEqual(["test/a.test.ts.money.adds", "test/b.test.ts.money.adds"])
    expect(r.tests?.counts.executed).toBe(2)
  })

  test("what bun itself writes gives ids from the repository's root", () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-bun-ids-"))
    mkdirSync(join(dir, "test/sub"), { recursive: true })
    writeFileSync(join(dir, "package.json"), "{}")
    const body = `import { describe, expect, test } from "bun:test"\ntest("top", () => expect(1).toBe(1))\ndescribe("grp", () => { test("x", () => expect(1).toBe(1)) })\n`
    writeFileSync(join(dir, "test/a.test.ts"), body)
    writeFileSync(join(dir, "test/sub/b.test.ts"), body)
    const out = join(dir, "junit.xml")
    Bun.spawnSync({ cmd: [process.execPath, "test", "--reporter=junit", `--reporter-outfile=${out}`], cwd: dir, env: { ...process.env, CI: "true", NO_COLOR: "1" } })
    const exit = Effect.runSyncExit(convertJUnit("unit", [{ path: "junit.xml", content: readFileSync(out, "utf8") }]))
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    expect(exit.value.tests.map((t) => t.id)).toEqual(["test/a.test.ts.grp.x", "test/a.test.ts.top", "test/sub/b.test.ts.grp.x", "test/sub/b.test.ts.top"])
  })
})
