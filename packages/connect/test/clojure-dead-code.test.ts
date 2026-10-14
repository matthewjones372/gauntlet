import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { clojureSpec } from "@gauntlet/pack-clojure"
import { CLOJURE_TOOLS } from "../src/pins.ts"
import { github } from "../src/index.ts"

// Spec 0017 §4: the Clojure pack's dead-code gate runs clj-kondo, as lint does,
// so a policy with dead-code and no lint still gets clj-kondo installed in CI.

const setupClojure = (gates: string) => {
  const policy = compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse clojure\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n` }, [clojureSpec])
  if (policy._tag === "Invalid") throw new Error("the policy doesn't compile")
  const workflow = github({ mode: "repo", ir: policy.compiled.ir, files: ["deps.edn"], gauntletVersion: "0.1.0", downloadUrl: "https://example.invalid/gauntlet" })[0]!.content
  const evidence = (Bun.YAML.parse(workflow) as { jobs: { evidence: { steps: { name?: string; with?: Record<string, string> }[] } } }).jobs.evidence
  return evidence.steps.find((s) => s.name === "Set up Clojure")?.with ?? {}
}

describe("connect github for a Clojure project", () => {
  test("a dead-code gate without lint still installs clj-kondo at the pinned version", () => {
    expect(setupClojure("build, dead-code ratchet")["clj-kondo"]).toBe(CLOJURE_TOOLS.cljKondo)
  })

  test("without lint or dead-code, clj-kondo isn't installed", () => {
    expect(setupClojure("build")["clj-kondo"]).toBeUndefined()
  })
})
