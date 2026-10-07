import { describe, expect, test } from "bun:test"
import { canonicalize, canonicalJson, DEFAULT_INTEGRITY, IMPLICIT_PROTECT, irHash, type PolicyIR } from "../src/index.ts"

const ir: PolicyIR = {
  irVersion: 1,
  name: "x",
  mode: "shadow",
  packs: ["jvm"],
  owners: ["@b", "@a", "@a"],
  protect: [{ group: "tests", kind: "tests", globs: ["b/**", "a/**"] }, IMPLICIT_PROTECT],
  zones: [{ name: "z2", globs: [], owners: [], rules: [] }, { name: "z1", globs: [], owners: [], rules: [] }],
  arch: [],
  suites: [],
  integrity: DEFAULT_INTEGRITY,
  budgets: [],
  gates: [{ name: "second", advisory: false, checks: [] }, { name: "first", advisory: false, checks: [] }],
  remediation: [],
  imports: [],
  predicates: [],
  review: [{ tier: "owner", conditions: [{ kind: "zone-touched" }] }, { tier: "owner", conditions: [{ kind: "zone-touched" }] }],
}

describe("canonicalJson", () => {
  test("sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: "x" }] })).toBe(`{"a":[2,{"c":"x"}],"b":1}`)
  })
})

describe("canonicalize", () => {
  const c = canonicalize(ir)
  test("sorts and dedupes sets", () => {
    expect(c.owners).toEqual(["@a", "@b"])
    expect(c.protect[1]?.globs).toEqual(["a/**", "b/**"])
    expect(c.zones.map((z) => z.name)).toEqual(["z1", "z2"])
    expect(c.review).toHaveLength(1)
  })
  test("keeps gate tier order", () => expect(c.gates.map((g) => g.name)).toEqual(["second", "first"]))
  test("is idempotent", () => expect(canonicalJson(canonicalize(c))).toBe(canonicalJson(c)))
  test("hash does not depend on input order", () => {
    expect(irHash({ ...ir, owners: ["@a", "@b"], zones: [...ir.zones].reverse() })).toBe(irHash(ir))
  })
})
