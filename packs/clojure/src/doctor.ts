import type { DoctorCheck } from "@gauntlet/core"
import { head, live, read } from "./syntax.ts"

/** The built-in Clojure reader reads nested forms, metadata and discards. */
export const doctor = (): ReadonlyArray<DoctorCheck> => {
  const forms = read("(ns a.b)\n(deftest ^:kaocha/skip t #_(is false) (is (= 1 1)))\n")
  const asserts = [...live(forms)].filter((f) => head(f) === "is").length
  return [{ what: "clojure: Clojure reader", ok: asserts === 1, detail: asserts === 1 ? "reads Clojure" : `expected 1 assertion, found ${asserts}` }]
}
