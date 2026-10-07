import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { PackRegistry, PolicyNotFound, PolicySource, ProcessRunner, renderDoctor, runDoctor } from "../src/index.ts"
import { scriptPack } from "./script-pack.ts"

// What doctor reports when tools are missing, with the processes faked.
const doctorWith = (available: ReadonlyArray<string>) =>
  Effect.runPromise(runDoctor("/repo").pipe(Effect.provide(Layer.mergeAll(
    Layer.succeed(ProcessRunner, {
      run: (r) => Effect.succeed(available.includes(r.command) ? { exitCode: 0, stdout: `${r.command} 1.0\n`, stderr: "" } : { exitCode: 127, stdout: "", stderr: "not found" }),
    }),
    Layer.succeed(PolicySource, { load: () => Effect.fail(new PolicyNotFound({ repo: "/repo", looked: [] })) }),
    PackRegistry.layer([{ ...scriptPack, doctor: () => [{ what: "script: assets", ok: true, detail: "embedded" }] }]),
  ))))

describe("gauntlet doctor", () => {
  test("missing git fails; pack tools are only informational", async () => {
    const checks = await doctorWith([])
    expect(checks.find((c) => c.what === "git")).toMatchObject({ ok: false, detail: "not found on PATH; Gauntlet needs git" })
    expect(checks.filter((c) => !c.ok && !c.optional).map((c) => c.what)).toEqual(["git"])
    expect(renderDoctor(checks)).toContain("FAIL  git")
  })

  test("pack self-checks are included, and without a policy every installed pack's tools are listed", async () => {
    const checks = await doctorWith(["git"])
    expect(checks.map((c) => c.what)).toEqual(["git", "script: assets", "policy", "jvm: java"])
    expect(checks.at(-1)).toMatchObject({ ok: false, optional: true })
    expect(checks.find((c) => c.what === "policy")?.detail).toBe("no readable .gauntlet/policy.gx here")
    expect(renderDoctor(checks).split("\n")[0]).toBe("ok    git             git 1.0")
  })
})
