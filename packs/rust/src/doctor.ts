import type { DoctorCheck } from "@gauntlet/core"
import { ofType, parseRust } from "./syntax.ts"

/** The embedded Rust grammar parses. */
export const doctor = (): ReadonlyArray<DoctorCheck> => {
  const calls = ofType(parseRust("fn f() -> i32 { g(1) }\n").rootNode, "call_expression").length
  return [{ what: "rust: Rust grammar", ok: calls === 1, detail: calls === 1 ? "parses Rust" : `expected 1 call, found ${calls}` }]
}
