import type { DoctorCheck } from "@gauntlet/core"
import { ofType, parseGo } from "./syntax.ts"

/** The embedded Go grammar parses. */
export const doctor = (): ReadonlyArray<DoctorCheck> => {
  const calls = ofType(parseGo("package p\n\nfunc f() int { return g(1) }\n").rootNode, "call_expression").length
  return [{ what: "go: Go grammar", ok: calls === 1, detail: calls === 1 ? "parses Go" : `expected 1 call, found ${calls}` }]
}
