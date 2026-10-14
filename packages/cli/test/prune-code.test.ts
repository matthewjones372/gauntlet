import { afterEach, describe, expect, test } from "bun:test"
import { emptyBaseline, encodeBaseline, type Result, type TestMap } from "@gauntlet/sarif"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// Spec 0017 §5: `gauntlet prune code` lists the dead-code findings the
// baseline at HEAD recorded, and main source no test ran (the baseline's test
// map) that nothing in the project names. It never changes anything.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const policy = (gates: string) => `gauntlet "svc"
use typescript
mode enforce
owners @platform
suites { unit "**/*.test.ts" affected }
gates { ${gates} }
`
const WITH_GATE = policy("fast { dead-code ratchet } verify { unit }")

const FILES = {
  "package.json": "{ \"name\": \"svc\", \"type\": \"module\" }\n",
  "src/money.ts": "import { usedRate } from \"./rates\"\nimport { fmt } from \"./format\"\n\nexport const legacyAdd = (a: number, b: number) => a + b\nexport const show = (n: number) => fmt(n * usedRate)\n",
  "src/money.test.ts": "import { expect, test } from \"bun:test\"\nimport { show } from \"./money\"\n\ntest(\"shows\", () => expect(show(1)).toBe(\"9200\"))\n",
  "src/rates.ts": "export const usedRate = 9200\n\nexport function forgotten() {\n  return 0\n}\n",
  "src/format.ts": "export const fmt = (n: number) => String(n)\n",
  "src/legacy.ts": "export function oldRate() {\n  return 1\n}\n",
  "src/start.ts": "import { show } from \"./money\"\n\nconsole.log(show(2))\n",
}

const MAP: TestMap = { "src/money.test.ts": ["src/money.test.ts", "src/money.ts"] }

const finding = (ruleId: string, uri: string, line: number, text: string): Result => ({
  ruleId, level: "warning", message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }],
})
const FINDINGS = {
  knip: [finding("dead-code/unused-export", "src/money.ts", 4, "unused export: legacyAdd"), finding("dead-code/unused-file", "src/gone.ts", 1, "unused file")],
  biome: [finding("lint/style/useConst", "src/money.ts", 1, "not dead code")],
}

const repo = (options: { readonly policy?: string; readonly testMap?: TestMap; readonly results?: Record<string, Result[]> } = {}) => {
  const r = new TempRepo().write({ ".gauntlet/policy.gx": options.policy ?? WITH_GATE, ...FILES })
  repos.push(r)
  const first = r.commit("start")
  r.write({ ".gauntlet/baseline.sarif": encodeBaseline({ ...emptyBaseline(first, "f".repeat(64), "0.0.0"), results: options.results ?? FINDINGS, ...(options.testMap ? { testMap: options.testMap } : {}) }) })
  r.commit("baseline")
  return { r, first }
}

describe("gauntlet prune code", () => {
  test("lists dead-code findings and unreferenced code no test ran, with why, and changes nothing", async () => {
    const { r, first } = repo({ testMap: MAP })
    const before = r.git("status", "--porcelain")
    const res = await cli(["prune", "code", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    expect(res.out).toContain(`Dead code the dead-code gate found, as recorded at ${first.slice(0, 12)} (1):\n  src/money.ts:4 dead-code/unused-export: knip reports unused export: legacyAdd.`)
    // A finding in a file that's gone since, and another gate's findings, aren't listed.
    expect(res.out).not.toContain("src/gone.ts")
    expect(res.out).not.toContain("useConst")
    expect(res.out).toContain(`Code no test ran and nothing in the project names (2; from the map of what the tests executed at ${first.slice(0, 12)}):`)
    expect(res.out).toContain("  src/legacy.ts: no test ran it, and no other file names it or anything it declares.")
    expect(res.out).toContain("  src/rates.ts:3 function forgotten: no test ran its file, and nothing in the project names it.")
    // Named elsewhere: not listed.
    expect(res.out).not.toContain("src/format.ts")
    expect(res.out).not.toContain("usedRate")
    // An entry point is left out, and counted.
    expect(res.out).not.toContain("src/start.ts")
    expect(res.out).toContain("Left out 1 file no test ran that something outside the code may start")
    expect(res.out).toContain("Gauntlet hasn't changed anything")
    expect(r.git("status", "--porcelain")).toBe(before)
  })

  test("--json gives the same list", async () => {
    const { r, first } = repo({ testMap: MAP })
    const found = JSON.parse((await cli(["prune", "code", "--repo", r.dir, "--json"], [...INSTALLED_PACKS])).out)
    expect(found.deadCode).toEqual({ commit: first, findings: [{ path: "src/money.ts", line: 4, rule: "dead-code/unused-export", tool: "knip", message: "unused export: legacyAdd" }] })
    expect(found.unused).toEqual({
      commit: first,
      notRun: 4,
      candidates: [
        { path: "src/legacy.ts", kind: "file", why: "no test ran it, and no other file names it or anything it declares" },
        { path: "src/rates.ts", name: "forgotten", kind: "function", line: 3, why: "no test ran its file, and nothing in the project names it" },
      ],
      leftOut: [{ path: "src/start.ts", why: "it runs code when it's loaded" }],
    })
  })

  test("without a dead-code gate it says how to add one; without a map, how to record one", async () => {
    const { r } = repo({ policy: policy("verify { unit }").replace(" affected", "") })
    const out = (await cli(["prune", "code", "--repo", r.dir], [...INSTALLED_PACKS])).out
    expect(out).toContain("No dead-code findings to list: the policy has no dead-code gate: add `dead-code ratchet`")
    expect(out).toContain("No code no test runs to list: the baseline records no map of what the tests execute: mark a suite `affected`")
  })

  test("with an affected suite and no map, it says to record one", async () => {
    const { r } = repo()
    expect((await cli(["prune", "code", "--repo", r.dir], [...INSTALLED_PACKS])).out).toContain("No code no test runs to list: the baseline records no map of what the tests execute: record it with `gauntlet baseline --update`, which says why when a build can't.")
  })

  test("a baseline with no dead-code findings, recorded with another policy, may predate the gate", async () => {
    const { r } = repo({ results: {} })
    expect((await cli(["prune", "code", "--repo", r.dir], [...INSTALLED_PACKS])).out).toContain("No dead-code findings to list: the baseline records none, and it was recorded with another policy")
  })

  test("a policy whose packs map no tests lists only the dead-code findings", async () => {
    const r = new TempRepo().write({
      ".gauntlet/policy.gx": "gauntlet \"svc\"\nuse go\nmode enforce\nowners @platform\nsuites { unit \"**/*_test.go\" }\ngates { fast { dead-code ratchet } verify { unit } }\n",
      "go.mod": "module example.com/svc\n\ngo 1.25\n",
      "money/money.go": "package money\n\nfunc Add(a, b int64) int64 { return a + b }\n\nfunc Sub(a, b int64) int64 { return a - b }\n",
    })
    repos.push(r)
    const first = r.commit("start")
    r.write({ ".gauntlet/baseline.sarif": encodeBaseline({ ...emptyBaseline(first, "f".repeat(64), "0.0.0"), results: { deadcode: [finding("dead-code/unreachable-func", "money/money.go", 5, "unreachable func: Sub")] } }) })
    r.commit("baseline")
    const out = (await cli(["prune", "code", "--repo", r.dir], [...INSTALLED_PACKS])).out
    expect(out).toContain("  money/money.go:5 dead-code/unreachable-func: deadcode reports unreachable func: Sub.")
    expect(out).toContain("No code no test runs to list: the policy's packs (go) don't map what each test runs yet: TypeScript and the JVM do.")
  })

  test("says when there's no baseline at HEAD", async () => {
    const bare = new TempRepo().write({ ".gauntlet/policy.gx": WITH_GATE, ...FILES })
    repos.push(bare)
    bare.commit("start")
    const out = (await cli(["prune", "code", "--repo", bare.dir], [...INSTALLED_PACKS])).out
    expect(out).toContain("No dead-code findings to list: there's no baseline at HEAD")
    expect(out).toContain("No code no test runs to list: there's no baseline at HEAD")
  })
})
