import { describe, expect, test } from "bun:test"
import { planMaterialisation, selectTests } from "../src/index.ts"
import { compiled } from "./fixtures.ts"

// Spec 0012 §2: scenario files are intent, protected like tests but judged as
// the base has them: an edit or a deletion is undone for the run, a new file
// is left out, and either way the change needs review.

const { ir } = compiled(`gauntlet "x"\nuse jvm\nowners @p\nprotect { tests "src/test/**" }\nsuites { unit "src/test/**" }\nscenarios "specs/**/*.feature"\ngates { verify { unit, scenarios } }\n`)

describe("scenario files in the judged checkout", () => {
  test("edits and deletions are undone, new files left out, test edits run as edited", () => {
    const plan = planMaterialisation([
      { status: "modified", path: "specs/fx.feature" },
      { status: "deleted", path: "specs/old.feature" },
      { status: "added", path: "specs/new.feature" },
      { status: "renamed", path: "specs/moved.feature", oldPath: "specs/fx2.feature" },
      { status: "modified", path: "src/test/FxTest.kt" },
    ], ir.protect, [], [], true)
    expect(plan.map((m) => `${m.path} ${m.kind} ${m.action}`)).toEqual([
      "specs/fx.feature scenarios restored",
      "specs/fx2.feature scenarios restored",
      "specs/moved.feature scenarios removed",
      "specs/new.feature scenarios removed",
      "specs/old.feature scenarios restored",
      "src/test/FxTest.kt tests edited",
    ])
  })

  test("a scenario edit doesn't make an affected suite run every test: no test reads scenario files", () => {
    const selection = selectTests({
      dir: ".", prefixed: false, buildDirs: ["."], location: "src/test/**", isTestPath: (p) => p.startsWith("src/test/"), protect: ir.protect, buildConfig: [], dependencyChanges: [],
      map: { "svc.FxTest": ["src/main/Fx.kt"], "svc.MoneyTest": ["src/main/Money.kt"] },
      changes: [{ path: "specs/fx.feature", status: "modified" }, { path: "src/main/Fx.kt", status: "modified" }],
    })
    expect(selection.kind).toBe("some")
  })
})
