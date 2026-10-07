import type { DoctorCheck } from "@gauntlet/core"
import { ofType, parsePython } from "./syntax.ts"

/** The embedded Python grammar parses. */
export const doctor = (): ReadonlyArray<DoctorCheck> => {
  const calls = ofType(parsePython("def f():\n    return g(1)\n").rootNode, "call").length
  return [{ what: "python: Python grammar", ok: calls === 1, detail: calls === 1 ? "parses Python" : `expected 1 call, found ${calls}` }]
}
