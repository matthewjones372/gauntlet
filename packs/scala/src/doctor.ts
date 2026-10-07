import type { DoctorCheck } from "@gauntlet/core"
import { ofType, parseScala } from "./syntax.ts"

/** The embedded Scala grammar parses (Scala 3 syntax). */
export const doctor = (): ReadonlyArray<DoctorCheck> => {
  const calls = ofType(parseScala("object A:\n  def f(): Int = g(1)\n").rootNode, "call_expression").length
  return [{ what: "scala: Scala grammar", ok: calls === 1, detail: calls === 1 ? "parses Scala" : `expected 1 call, found ${calls}` }]
}
