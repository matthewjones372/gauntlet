import { describe, expect, test } from "bun:test"
import { editBlock, policyBlocks } from "../src/index.ts"

const POLICY = `// Our policy.
gauntlet "svc"
use jvm
mode shadow

protect {
  tests "src/test/**"
}

// Money needs its owners.
zone money {
  paths "src/money/**"
  owner @payments
}

gates {
  fast { build }
}

review {
  auto when all gates pass
}
`

const edited = (r: ReturnType<typeof editBlock>) => {
  if (r._tag !== "Edited") throw new Error(r.reason)
  return r.text
}

describe("policy blocks", () => {
  test("blocks are found by kind and name, with their text range", () => {
    const r = policyBlocks("p.gx", POLICY)
    if (r._tag !== "Blocks") throw new Error("parse failed")
    expect(r.blocks.map((b) => (b.name ? `${b.kind}:${b.name}` : b.kind))).toEqual(["use", "mode", "protect", "zone:money", "gates", "review"])
    const zone = r.blocks.find((b) => b.kind === "zone")!
    expect(POLICY.slice(zone.start, zone.end)).toStartWith("zone money {")
    expect(POLICY.slice(zone.start, zone.end)).toEndWith("}")
  })

  test("replacing a block keeps the comment above it and everything else", () => {
    const text = edited(editBlock("p.gx", POLICY, { op: "set", id: { kind: "zone", name: "money" }, text: `zone money {\n  paths "src/money/**", "src/fx/**"\n  owner @payments\n}` }))
    expect(text).toContain(`// Money needs its owners.\nzone money {\n  paths "src/money/**", "src/fx/**"`)
    expect(text.replace(`, "src/fx/**"`, "")).toBe(POLICY)
  })

  test("a new block lands after the last block that usually comes before it", () => {
    const arch = edited(editBlock("p.gx", POLICY, { op: "set", id: { kind: "arch" }, text: "arch { module domain must not depend on infra }" }))
    expect(arch.indexOf("arch {")).toBeGreaterThan(arch.indexOf("zone money"))
    expect(arch.indexOf("arch {")).toBeLessThan(arch.indexOf("gates {"))
    const owners = edited(editBlock("p.gx", POLICY, { op: "set", id: { kind: "owners" }, text: "owners @platform" }))
    expect(owners).toContain("mode shadow\n\nowners @platform\n\nprotect {")
  })

  test("removing a block leaves no gap behind", () => {
    const text = edited(editBlock("p.gx", POLICY, { op: "remove", id: { kind: "gates" } }))
    expect(text).not.toContain("gates {")
    expect(text).not.toMatch(/\n{3}/)
    expect(editBlock("p.gx", POLICY, { op: "remove", id: { kind: "arch" } })).toEqual({ _tag: "Failed", reason: "there is no arch block to remove" })
  })

  test("a block that would come first goes before the first block, after the header and its comments", () => {
    const bare = `// note\ngauntlet "svc"\nprotect { tests "t/**" }\n`
    expect(edited(editBlock("p.gx", bare, { op: "set", id: { kind: "use" }, text: "use jvm" }))).toBe(`// note\ngauntlet "svc"\nuse jvm\n\nprotect { tests "t/**" }\n`)
    expect(edited(editBlock("p.gx", `gauntlet "svc"\n`, { op: "set", id: { kind: "use" }, text: "use jvm" }))).toBe(`gauntlet "svc"\n\nuse jvm\n`)
  })
})
