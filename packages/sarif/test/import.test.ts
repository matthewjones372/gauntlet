import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { importSarif, parseDetektBaseline, relativeUri, renderDetektBaseline } from "../src/index.ts"

const semgrep = JSON.stringify({
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: "semgrep", rules: [{ id: "x" }] } },
    results: [{
      ruleId: "java.lang.security.sqli",
      level: "error",
      message: { text: "SQL injection" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "file:///repo/src/main/Db.kt" }, region: { startLine: 4 } } }],
      fixes: [{ description: { text: "use a prepared statement" } }],
    }],
  }],
})

describe("importSarif", () => {
  test("decodes runs, keeps paths relative and drops fields outside the subset", () => {
    const exit = Effect.runSyncExit(importSarif("semgrep", semgrep, { trust: "evidence", repoRoot: "/repo", check: "semgrep" }))
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    const result = exit.value[0]!.results[0]!
    expect(result.locations?.[0]?.physicalLocation?.artifactLocation?.uri).toBe("src/main/Db.kt")
    expect("fixes" in result).toBe(false)
    expect(exit.value[0]!.properties?.gauntlet?.trust).toBe("evidence")
    expect(result.properties?.gauntlet?.caution).toBeUndefined()
  })

  test("results from a caution source are marked caution-only", () => {
    const exit = Effect.runSyncExit(importSarif("reviewer", semgrep, { trust: "caution", repoRoot: "/repo", check: "reviewer" }))
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    expect(exit.value[0]!.results.every((r) => r.properties?.gauntlet?.caution === true)).toBe(true)
  })

  test("invalid SARIF is SarifInvalid", () => {
    expect(Exit.isFailure(Effect.runSyncExit(importSarif("x", "{", { trust: "evidence", repoRoot: "/", check: "x" })))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(importSarif("x", `{"version":"1.0","runs":[]}`, { trust: "evidence", repoRoot: "/", check: "x" })))).toBe(true)
  })

  test("relativeUri handles file URIs, roots and ./", () => {
    expect(relativeUri("file:///repo/a%20b/C.kt", "/repo")).toBe("a b/C.kt")
    expect(relativeUri("./src/A.kt", "/repo")).toBe("src/A.kt")
    expect(relativeUri("src/A.kt", "/repo/")).toBe("src/A.kt")
  })
})

describe("detekt baselines", () => {
  const xml = `<?xml version="1.0" ?>
<SmellBaseline>
  <ManuallySuppressedIssues><ID>MagicNumber:Fx.kt$Fx$1.1</ID></ManuallySuppressedIssues>
  <CurrentIssues>
    <ID>LongMethod:Fx.kt$Fx$fun convert(amount: Long): Long</ID>
    <ID>ComplexCondition:A.kt$A$a &amp;&amp; b</ID>
  </CurrentIssues>
</SmellBaseline>`

  test("imports every id as a legacy entry", () => {
    const exit = Effect.runSyncExit(parseDetektBaseline(xml))
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    expect(exit.value.map((e) => e.id)).toEqual([
      "ComplexCondition:A.kt$A$a && b",
      "LongMethod:Fx.kt$Fx$fun convert(amount: Long): Long",
      "MagicNumber:Fx.kt$Fx$1.1",
    ])
  })

  test("renders back to a baseline detekt reads the same way", () => {
    const entries = Effect.runSync(parseDetektBaseline(xml))
    expect(Effect.runSync(parseDetektBaseline(renderDetektBaseline(entries)))).toEqual(entries)
  })

  test("an empty baseline has no entries, and junk is an error", () => {
    expect(Effect.runSync(parseDetektBaseline(`<SmellBaseline><CurrentIssues/></SmellBaseline>`))).toEqual([])
    expect(Exit.isFailure(Effect.runSyncExit(parseDetektBaseline(`<other/>`)))).toBe(true)
  })
})
