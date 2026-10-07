import type { DoctorCheck } from "@gauntlet/core"
import initScript from "./assets/gauntlet.init.gradle" with { type: "text" }
import { ofType, parseKotlin } from "./kotlin/syntax.ts"

/** The embedded Kotlin grammar parses, and the Gradle init script is in the build. */
export const doctor = (): ReadonlyArray<DoctorCheck> => {
  const calls = ofType(parseKotlin("fun main() { println(1) }").rootNode, "call_expression").length
  return [
    { what: "jvm: Kotlin grammar", ok: calls === 1, detail: calls === 1 ? "parses Kotlin" : `expected 1 call, found ${calls}` },
    { what: "jvm: Gradle init script", ok: initScript.includes("GAUNTLET_OUT"), detail: `${initScript.length} bytes embedded` },
  ]
}
