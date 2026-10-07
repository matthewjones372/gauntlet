import { describe, expect, test } from "bun:test"
import { compilePolicy, formatDiagnostics } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// The IR hash identifies what a policy means. Edits that change only layout,
// comments, separators or the order of things whose order carries no meaning
// must keep it; edits that change meaning must change it.

const hashOf = (text: string): string => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text }, installed)
  if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, text))
  return r.compiled.hash
}

const base = `gauntlet "svc"
use jvm
mode enforce
owners @platform, @security
protect {
  tests "src/test/**", "src/acceptance/**"
  config "*.gradle.kts"
}
zone money { paths "src/**/money/**", "src/**/fx/**" owner @payments }
zone auth { paths "src/**/auth/**" owner @security }
suites { unit "src/test/**" }
integrity { forbid new skips, exit in tests }
gates {
  fast { build, lint ratchet }
  verify { unit, coverage >= 90% on changed }
}
predicate small = diff < 150 lines and no zone touched
review {
  owner when zone touched
  review when protected changed
  auto when small and all gates pass
}
`

const sameMeaning = `// A comment, different spacing, no commas, and things reordered.
gauntlet "svc"


owners @security @platform
mode enforce
use jvm

zone auth {
  paths "src/**/auth/**"
  owner @security
}
zone money {
  paths "src/**/fx/**"
        "src/**/money/**"
  owner @payments
}
protect {
  config "*.gradle.kts"
  tests  "src/acceptance/**" "src/test/**"
}
suites {
  unit "src/test/**"
}
integrity {
  forbid exit in tests
  forbid new skips
}
gates {
  fast { lint ratchet
         build }
  verify { coverage >= 90% on changed
           unit }
}
predicate small = no zone touched and diff < 150 lines
review {
  auto when all gates pass and small
  review when protected changed
  owner when zone touched
}
`

describe("IR hash", () => {
  test("is a sha256 hex digest", () => expect(hashOf(base)).toMatch(/^[0-9a-f]{64}$/))

  test("ignores comments, layout, separators and meaningless order", () => {
    expect(hashOf(sameMeaning)).toBe(hashOf(base))
  })

  test("trailing slash on a glob means everything under it", () => {
    expect(hashOf(base.replace(`"src/test/**", "src/acceptance/**"`, `"src/test/", "src/acceptance/**"`))).toBe(hashOf(base))
  })

  const changes: ReadonlyArray<[string, string, string]> = [
    ["mode", "mode enforce", "mode shadow"],
    ["threshold", "coverage >= 90%", "coverage >= 80%"],
    ["scope", "coverage >= 90% on changed", "coverage >= 90% on all"],
    ["ratchet removed", "lint ratchet", "lint"],
    ["protected path removed", `"src/test/**", "src/acceptance/**"`, `"src/test/**"`],
    ["zone path removed", `"src/**/money/**", "src/**/fx/**"`, `"src/**/money/**"`],
    ["owner changed", "owner @payments", "owner @finance"],
    ["review tier", "review when protected changed", "owner when protected changed"],
    ["predicate", "diff < 150 lines", "diff < 300 lines"],
    ["policy name", `gauntlet "svc"`, `gauntlet "svc2"`],
  ]
  for (const [what, from, to] of changes) {
    test(`changes when the ${what} changes`, () => {
      const edited = base.replace(from, to)
      expect(edited).not.toBe(base)
      expect(hashOf(edited)).not.toBe(hashOf(base))
    })
  }

  test("gate tier order matters, because tiers run in order", () => {
    const swapped = base.replace(
      "  fast { build, lint ratchet }\n  verify { unit, coverage >= 90% on changed }",
      "  verify { unit, coverage >= 90% on changed }\n  fast { build, lint ratchet }",
    )
    expect(hashOf(swapped)).not.toBe(hashOf(base))
  })
})
