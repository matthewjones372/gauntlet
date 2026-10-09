import { afterEach, describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { findWrapper } from "../src/gradle.ts"

// ADR 0022: an included Gradle build without a wrapper of its own uses the
// nearest one above it, and the search never leaves the checkout.

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const find = (dir: string) => Effect.runPromise(findWrapper(dir).pipe(Effect.provide(BunServices.layer)))

describe("findWrapper", () => {
  test("its own wrapper, or the nearest one above it", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrapper-"))
    dirs.push(root)
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, "lark-bank", "events"), { recursive: true })
    writeFileSync(join(root, "lark-bank", "gradlew"), "")
    expect(await find(join(root, "lark-bank"))).toEqual(Option.some(join(root, "lark-bank", "gradlew")))
    expect(await find(join(root, "lark-bank", "events"))).toEqual(Option.some(join(root, "lark-bank", "gradlew")))
  })

  test("none when there's no wrapper up to the checkout's root", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrapper-"))
    dirs.push(root)
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, "svc"))
    expect(await find(join(root, "svc"))).toEqual(Option.none())
  })
})
