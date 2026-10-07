import { expect } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Compares `actual` with the golden file at `path`. With UPDATE_GOLDEN=1 the
 * file is (re)written instead; CI never sets it.
 */
export const expectGolden = (path: string, actual: string) => {
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) {
    if (process.env.CI && !existsSync(path)) throw new Error(`missing golden file ${path}; run with UPDATE_GOLDEN=1 locally`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, actual)
    return
  }
  expect(actual).toBe(readFileSync(path, "utf8"))
}
