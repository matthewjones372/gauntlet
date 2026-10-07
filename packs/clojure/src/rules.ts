import type { RuleSpec } from "@gauntlet/dsl"
import type { Result } from "@gauntlet/sarif"
import { type Form, head, live, local, read } from "./syntax.ts"

// Pack rules a zone can name (`rule clojure.no-throw`), run in the lint gate
// and reported as SARIF, so they are grandfathered and ratcheted like any lint
// finding.

export const RULES: ReadonlyArray<RuleSpec> = [
  { name: "clojure.no-floating-money", description: "money is never held in a double" },
  { name: "clojure.no-throw", description: "errors are data (ex-info returned, or result maps), not thrown" },
  { name: "clojure.no-mutable-state", description: "no atoms, refs, agents, volatiles or set!" },
  { name: "clojure.no-unsafe-read", description: "no eval, load-string or clojure.core/read-string: use clojure.edn" },
  { name: "clojure.no-println", description: "no println, prn or print: log instead" },
]

const MONEY_NAME = /amount|price|money|total|balance|cost|fee|rate|sum|cash|payment/i
const FLOAT_LITERAL = /^[+-]?\d+\.\d*([eE][+-]?\d+)?$|^[+-]?\d+[eE][+-]?\d+$/

const result = (ruleId: string, path: string, at: Form, message: string): Result => ({
  ruleId,
  level: "warning",
  message: { text: message },
  locations: [{ physicalLocation: { artifactLocation: { uri: path }, region: { startLine: at.line } } }],
})

const isFloat = (f: Form | undefined) => f !== undefined && ((f.type === "number" && FLOAT_LITERAL.test(f.text)) || /^(double|float)$/.test(local(head(f))) || f.meta.includes(":tag double"))

/** Name and value pairs that bind: `(def price 9.99)`, `(let [amount 1.5] ...)`, `{:keys ...}` aside. */
const bindings = (forms: ReadonlyArray<Form>): { name: Form; value: Form | undefined }[] => {
  const out: { name: Form; value: Form | undefined }[] = []
  for (const f of live(forms)) {
    const h = local(head(f))
    if (h === "def" && f.children[1]?.type === "symbol") out.push({ name: f.children[1], value: f.children[2] })
    if (/^(let|loop|binding|when-let|if-let|with-open)$/.test(h) && f.children[1]?.type === "vector") {
      const v = f.children[1].children
      for (let k = 0; k + 1 < v.length; k += 2) if (v[k]!.type === "symbol") out.push({ name: v[k]!, value: v[k + 1] })
    }
    // ^double parameters: (defn charge [^double amount] ...).
    if (f.type === "vector") for (const p of f.children) if (p.type === "symbol" && p.meta.includes(":tag double")) out.push({ name: p, value: p })
  }
  return out
}

const CHECKS: Record<string, (path: string, forms: ReadonlyArray<Form>) => Result[]> = {
  "clojure.no-floating-money": (path, forms) =>
    bindings(forms).filter((b) => MONEY_NAME.test(b.name.text) && isFloat(b.value))
      .map((b) => result("clojure.no-floating-money", path, b.name, `'${b.name.text}' holds money in a double; use integer minor units or bigdec.`)),
  "clojure.no-throw": (path, forms) =>
    [...live(forms)].filter((f) => local(head(f)) === "throw")
      .map((f) => result("clojure.no-throw", path, f, "Thrown exception; return the error as data instead.")),
  "clojure.no-mutable-state": (path, forms) =>
    [...live(forms)].filter((f) => /^(atom|ref|agent|volatile!|set!|reset!|swap!|vreset!|vswap!|alter|ref-set)$/.test(local(head(f))))
      .map((f) => result("clojure.no-mutable-state", path, f, `${local(head(f))} introduces mutable state; pass values through functions.`)),
  "clojure.no-unsafe-read": (path, forms) =>
    [...live(forms)].filter((f) => /^(eval|load-string|clojure\.core\/read-string|read-string)$/.test(head(f)))
      .map((f) => result("clojure.no-unsafe-read", path, f, `${head(f)} can run arbitrary code; read data with clojure.edn/read-string.`)),
  "clojure.no-println": (path, forms) =>
    [...live(forms)].filter((f) => /^(println|prn|print|pr|printf)$/.test(head(f)))
      .map((f) => result("clojure.no-println", path, f, `${head(f)} writes to stdout; use a logger.`)),
}

export const runRules = (rules: ReadonlyArray<string>, files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Result[] => {
  const checks = rules.flatMap((r) => (CHECKS[r] ? [CHECKS[r]] : []))
  if (checks.length === 0) return []
  const lineOf = (r: Result) => r.locations?.[0]?.physicalLocation?.region?.startLine ?? 0
  return files.flatMap((f) => {
    const forms = read(f.text)
    return checks.flatMap((check) => check(f.path, forms)).sort((a, b) => lineOf(a) - lineOf(b) || (a.ruleId < b.ruleId ? -1 : 1))
  })
}
