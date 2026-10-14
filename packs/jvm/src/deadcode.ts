import type { Run } from "@gauntlet/sarif"

// detekt's unused rules as dead-code findings (spec 0017 §4), from the same
// SARIF the lint gate reads. detekt reads one file at a time, so only what's
// private or local is found: an unused public declaration may be called from
// another module, and needs the map of what calls what (spec 0017 §5).

export const DEAD_CODE = "dead-code"

/** detekt's rules (detekt 2's names, and detekt 1's where they differ) that find dead code, and the kind each is reported as. */
export const DETEKT_DEAD_CODE: Readonly<Record<string, string>> = {
  UnusedImport: "unused-import",
  UnusedImports: "unused-import",
  UnusedPrivateClass: "unused-private-class",
  UnusedPrivateFunction: "unused-private-function",
  UnusedPrivateMember: "unused-private-function",
  UnusedPrivateProperty: "unused-private-property",
  UnusedParameter: "unused-parameter",
  UnusedVariable: "unused-variable",
  UnreachableCode: "unreachable-code",
}

/** The rule's name from detekt's SARIF rule id, `detekt.style.UnusedPrivateFunction`. */
const ruleName = (ruleId: string) => ruleId.split(".").at(-1) ?? ruleId

/** detekt's runs as one SARIF run named `detekt`, keeping the unused rules' findings as `dead-code/<kind>`. */
export const detektDeadCode = (runs: ReadonlyArray<Run>): Run => ({
  tool: { driver: { name: "detekt" } },
  results: runs.flatMap((r) => r.results.flatMap((x) => {
    const kind = DETEKT_DEAD_CODE[ruleName(x.ruleId)]
    return kind ? [{ ...x, ruleId: `${DEAD_CODE}/${kind}`, level: "warning" as const }] : []
  })),
})

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

/**
 * The unused rules detekt ran, from the rule list in its SARIF reports: a
 * rule its configuration turns off, or one the `detekt` task doesn't run
 * (detekt 2.0.0-alpha.6 with its defaults runs UnusedParameter and
 * UnusedPrivateClass only), is listed as not enabled. Undefined when no
 * report lists its rules.
 */
export const enabledDeadCodeRules = (reports: ReadonlyArray<string>): string[] | undefined => {
  let listed = false
  const on = new Set<string>()
  for (const text of reports) {
    let log: unknown
    try {
      log = JSON.parse(text)
    } catch {
      continue
    }
    for (const run of isRecord(log) && Array.isArray(log.runs) ? log.runs : []) {
      const rules = isRecord(run) && isRecord(run.tool) && isRecord(run.tool.driver) ? run.tool.driver.rules : undefined
      if (!Array.isArray(rules)) continue
      listed = true
      for (const rule of rules) {
        if (!isRecord(rule)) continue
        const name = typeof rule.name === "string" ? rule.name : typeof rule.id === "string" ? ruleName(rule.id) : undefined
        const enabled = !isRecord(rule.defaultConfiguration) || rule.defaultConfiguration.enabled !== false
        if (name !== undefined && enabled && name in DETEKT_DEAD_CODE) on.add(name)
      }
    }
  }
  return listed ? [...on].sort() : undefined
}
