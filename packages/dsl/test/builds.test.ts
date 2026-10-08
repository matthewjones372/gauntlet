import { describe, expect, test } from "bun:test"
import { compilePolicy } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

// A repository with several builds names each one's folder after its pack.

const compile = (use: string, files?: string[]) =>
  compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "x"\n${use}\nowners @p\ngates { fast { lint } }\n`, ...(files ? { files } : {}) }, installed)
const ir = (use: string, files?: string[]) => {
  const r = compile(use, files)
  if (r._tag !== "Compiled") throw new Error(JSON.stringify(r))
  return r.compiled
}

describe("use … in", () => {
  test("each pack's folders become builds, sorted by folder", () => {
    expect(ir(`use jvm in "lark-bank", "./bank-access/", lintonly in "bank-checks"`).ir.builds).toEqual([
      { pack: "jvm", dir: "bank-access" },
      { pack: "lintonly", dir: "bank-checks" },
      { pack: "jvm", dir: "lark-bank" },
    ])
  })

  test("once one pack names folders, one that names none builds at the root", () => {
    expect(ir(`use jvm, lintonly in "checks"`).ir.builds).toEqual([{ pack: "jvm", dir: "." }, { pack: "lintonly", dir: "checks" }])
  })

  test("without folders there are no builds, so existing policies keep their hash", () => {
    const plain = ir("use jvm, lintonly")
    expect(plain.ir.builds).toBeUndefined()
    expect(plain.hash).toBe(ir("use jvm lintonly").hash)
  })

  test("a folder outside the repository, or listed twice, is an error", () => {
    expect(compile(`use jvm in "../other"`)._tag).toBe("Invalid")
    expect(compile(`use jvm in "/abs"`)._tag).toBe("Invalid")
    expect(compile(`use jvm in "a", "a/"`)._tag).toBe("Invalid")
  })

  test("a folder with no files is a warning", () => {
    expect(ir(`use jvm in "lark-bank", "typo"`, ["lark-bank/build.gradle.kts"]).diagnostics.filter((d) => d.code.startsWith("build")).map((d) => `${d.code}:${d.message}`)).toEqual([
      `build-dir-empty:"typo" for 'jvm' has no files in the repository.`,
    ])
  })
})
