import type { Run } from "@gauntlet/sarif"
import { convertClippy } from "./reports.ts"

// rustc's own lints for dead code, from `cargo check --message-format=json`
// (spec 0017 §4): items nothing uses (`dead_code`), and imports, variables
// and macros nothing uses, and statements that can't run. rustc judges each
// target, the library as built for release among them, so an item only tests
// use is reported; a `pub` item outside a binary is used by whoever depends
// on the crate, so it never is.

export const DEAD_CODE = "dead-code"

/** The rustc lints that find dead code, and the kind each is reported as (`dead_code`'s by what's never used). */
export const RUSTC_DEAD_CODE: Readonly<Record<string, string>> = {
  dead_code: "unused-item",
  unused_imports: "unused-import",
  unused_variables: "unused-variable",
  unused_macros: "unused-macro",
  unreachable_code: "unreachable-code",
}

// What `dead_code` says is never used, longest first: "function `helper` is
// never used", "fields `a` and `b` are never read", "multiple variants are
// never constructed".
const ITEMS = ["associated function", "associated constant", "associated item", "type alias", "function", "method", "struct", "enum", "union", "field", "variant", "constant", "static", "trait", "module", "macro"]
const ITEM = new RegExp(`^(?:multiple )?(${ITEMS.join("|")})s? `)

const kindOf = (lint: string, message: string): string => {
  if (lint !== "dead_code") return RUSTC_DEAD_CODE[lint]!
  const item = ITEM.exec(message)?.[1]
  return item ? `unused-${item.replace(/^associated (function|constant)$/, "$1").replace(/^associated item$/, "item").replace(" ", "-")}` : "unused-item"
}

/**
 * cargo's JSON messages as a SARIF run named `rustc`, each dead-code lint
 * `dead-code/<kind>` with its file and line, once however many targets
 * reported it. Other lints and compiler errors aren't dead code.
 */
export const parseRustcDeadCode = (stdout: string, repoRoot: string): Run => {
  const all = convertClippy(stdout, repoRoot)
  return {
    tool: { driver: { name: "rustc" } },
    results: all.results.filter((r) => r.ruleId in RUSTC_DEAD_CODE).map((r) => ({ ...r, ruleId: `${DEAD_CODE}/${kindOf(r.ruleId, r.message.text)}`, level: "warning" })),
  }
}

/** Whether cargo's stdout is its JSON messages: every non-blank line is a JSON object with a `reason`. */
export const isCargoJson = (stdout: string): boolean =>
  stdout.split("\n").filter((l) => l.trim() !== "").every((l) => {
    try {
      const x: unknown = JSON.parse(l)
      return typeof x === "object" && x !== null && typeof (x as { reason?: unknown }).reason === "string"
    } catch {
      return false
    }
  })
