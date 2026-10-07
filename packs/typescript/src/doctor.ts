import type { DoctorCheck } from "@gauntlet/core"
import { ofType, parseTs } from "./syntax.ts"

/** The embedded TypeScript and TSX grammars parse. */
export const doctor = (): ReadonlyArray<DoctorCheck> => {
  const ts = ofType(parseTs("a.ts", "const x: number = f(1)").rootNode, "call_expression").length
  const tsx = ofType(parseTs("a.tsx", "const x = <A b={f(1)} />").rootNode, "jsx_self_closing_element").length
  return [
    { what: "typescript: TypeScript grammar", ok: ts === 1, detail: ts === 1 ? "parses TypeScript" : `expected 1 call, found ${ts}` },
    { what: "typescript: TSX grammar", ok: tsx === 1, detail: tsx === 1 ? "parses TSX" : `expected 1 element, found ${tsx}` },
  ]
}
