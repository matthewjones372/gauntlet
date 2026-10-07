import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { clojureSpec } from "@gauntlet/pack-clojure"
import { github } from "../src/index.ts"

const policy = (gates: string) => {
  const compiled = compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse clojure\nmode enforce\nowners @platform\n\nsuites { unit "test/**" }\n\ngates {\n  ${gates}\n}\n\nreview {\n  auto when all gates pass\n}\n` }, [clojureSpec])
  if (compiled._tag === "Invalid") throw new Error("the Clojure policy doesn't compile")
  return compiled.compiled.ir
}
type Step = { name?: string; uses?: string; with?: Record<string, unknown> }
const steps = (gates: string, files: string[]) =>
  (Bun.YAML.parse(github({ mode: "repo", ir: policy(gates), files, gauntletVersion: "0.1.0", downloadUrl: "https://example.invalid/gauntlet" })[0]!.content) as { jobs: { evidence: { steps: Step[] } } }).jobs.evidence.steps

describe("connect github for a Clojure project", () => {
  test("deps.edn: Java, the Clojure CLI, and clj-kondo when lint is gated", () => {
    const s = steps("fast { build, lint ratchet }\n  verify { unit }", ["deps.edn"])
    expect(s.find((x) => x.name === "Set up Java")?.with).toEqual({ distribution: "temurin", "java-version": "21" })
    const clojure = s.find((x) => x.name === "Set up Clojure")
    expect(clojure?.uses).toMatch(/^DeLaGuardo\/setup-clojure@[0-9a-f]{40}$/)
    expect(clojure?.with).toEqual({ cli: "1.12.6.1673", "clj-kondo": "2026.08.04" })
  })

  test("Leiningen, without lint", () => {
    expect(steps("fast { build }\n  verify { unit }", ["project.clj"]).find((x) => x.name === "Set up Clojure")?.with).toEqual({ lein: "2.12.0" })
  })
})
