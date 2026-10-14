import { describe, expect, test } from "bun:test"
import { typescriptCode } from "../src/prune.ts"

// Spec 0017 §5: how the TypeScript pack reads main source for `gauntlet prune code`.

const FILE = `import { x } from "./y"

export function convert(minor: number) { return minor }
export const rate = () => 1, scale = 2
export class Fx {
  run() {}
  private hidden() {}
  #secret() {}
  constructor() {}
}
export interface Quote { a: number }
export enum Side { Buy }
const local = 1
export { local as alias }
export * from "./z"
`

describe("typescriptCode", () => {
  test("reads main source only", () => {
    expect(typescriptCode.reads("src/fx.ts")).toBe(true)
    expect(typescriptCode.reads("src/fx.test.ts")).toBe(false)
    expect(typescriptCode.reads("src/fx.d.ts")).toBe(false)
    expect(typescriptCode.reads("vite.config.ts")).toBe(false)
  })

  test("what a file exports, with the public methods of its classes", () => {
    const { declared, leftOut } = typescriptCode.survey("src/fx.ts", FILE)
    expect(leftOut).toBeUndefined()
    expect(declared.map((d) => `${d.line} ${d.kind} ${d.in ? `${d.in}.` : ""}${d.name}`)).toEqual([
      "3 function convert",
      "4 function rate",
      "4 constant scale",
      "5 class Fx",
      "6 method Fx.run",
      "11 type Quote",
      "12 enum Side",
      "14 export alias",
    ])
  })

  test("entry points are left out, with why", () => {
    const why = (path: string, text: string) => typescriptCode.survey(path, text).leftOut
    expect(why("src/tool.ts", "#!/usr/bin/env node\nexport const a = 1\n")).toContain("#!")
    expect(why("src/main.ts", "export const a = 1\n")).toContain("entry point")
    expect(why("src/index.ts", "export const a = 1\n")).toContain("entry point")
    expect(why("src/pages/about.tsx", "export const a = 1\n")).toContain("framework")
    expect(why("src/app.config.ts", "export const a = 1\n")).toBeDefined()
    expect(why("src/handler.ts", "export default function handler() {}\n")).toContain("default export")
    expect(why("src/start.ts", "import { serve } from \"./serve\"\nserve(8080)\n")).toBe("it runs code when it's loaded")
    expect(why("src/plain.ts", "\"use strict\"\nexport const a = 1\n")).toBeUndefined()
  })
})
