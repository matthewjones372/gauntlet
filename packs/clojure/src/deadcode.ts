import type { Run } from "@gauntlet/sarif"
import { Option } from "effect"
import { convertKondo } from "./reports.ts"

// clj-kondo's unused-* findings as dead-code findings (spec 0017 §4): the
// same JSON the lint gate reads, kept to what's declared or bound and never
// used. clj-kondo reads one namespace at a time, so an unused public var isn't
// one of them: something outside the namespace may call it.

export const DEAD_CODE = "dead-code"

/**
 * clj-kondo's linters that find dead code. `unused-alias` is off unless the
 * project's .clj-kondo/config.edn turns it on; the project's configuration
 * can also turn the others off or exclude names, as it does for lint.
 */
export const KONDO_DEAD_CODE = ["unused-binding", "unused-private-var", "unused-namespace", "unused-referred-var", "unused-import", "unused-alias"] as const

/** Findings that mean clj-kondo couldn't read a file, so its dead code would go unseen. */
const UNREAD = new Set(["syntax", "file"])

export type KondoDeadCode =
  | { readonly _tag: "Read"; readonly run: Run }
  | { readonly _tag: "Unread"; readonly where: string }

/**
 * clj-kondo's JSON as a SARIF run named `clj-kondo`, each unused-* finding
 * `dead-code/<linter>`; Unread with where and why when clj-kondo couldn't read
 * a file; none when it isn't clj-kondo's JSON.
 */
export const parseKondoDeadCode = (json: string, repoRoot: string): Option.Option<KondoDeadCode> =>
  Option.map(convertKondo(json, repoRoot), (run): KondoDeadCode => {
    const unread = run.results.find((r) => UNREAD.has(r.ruleId))
    if (unread) {
      const at = unread.locations?.[0]?.physicalLocation
      return { _tag: "Unread", where: `${at?.artifactLocation?.uri ?? "?"}:${at?.region?.startLine ?? 1}: ${unread.message.text}` }
    }
    const kinds = new Set<string>(KONDO_DEAD_CODE)
    return {
      _tag: "Read",
      run: { ...run, results: run.results.filter((r) => kinds.has(r.ruleId)).map((r) => ({ ...r, ruleId: `${DEAD_CODE}/${r.ruleId}`, level: "warning" })) },
    }
  })
