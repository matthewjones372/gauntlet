import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { ciBuildFor, parseCiConfig, type ProcessRunner, wrappedRunner } from "../src/index.ts"

// Gauntlet's GitHub check builds a project as its own CI does (.gauntlet/ci.yml).

const config = Option.getOrThrow(parseCiConfig(`setup:
  - uses: cachix/install-nix-action@v31
builds:
  lark-bank:
    wrap: nix develop .#ci -c
    tool: ./gradlew -PlarkSource=$GITHUB_WORKSPACE/deps/lark
  bank-checks:
    wrap: nix develop -c
`))

describe(".gauntlet/ci.yml", () => {
  test("reads the setup steps and each build's way of running", () => {
    expect(config.setup).toEqual([{ uses: "cachix/install-nix-action@v31" }])
    expect(config.builds["bank-checks"]).toEqual({ wrap: "nix develop -c" })
  })

  test("an included build uses its parent's settings; one with none, nothing", () => {
    expect(ciBuildFor(config, "lark-bank/events")).toEqual(config.builds["lark-bank"])
    expect(ciBuildFor(config, "elsewhere")).toBeUndefined()
  })

  test("not YAML, or not a mapping, is none", () => {
    expect(parseCiConfig(": : :")).toEqual(Option.none())
    expect(parseCiConfig("just text")).toEqual(Option.none())
  })
})

describe("running a build's tools as CI does", () => {
  const seen: string[][] = []
  const runner: ProcessRunner["Service"] = { run: (r) => Effect.sync(() => (seen.push([r.command, ...r.args]), { exitCode: 0, stdout: "", stderr: "" })) }
  const wrapped = wrappedRunner(runner, config.builds["lark-bank"]!, { GITHUB_WORKSPACE: "/ws" })

  test("the tool gains CI's settings and keeps its own path; everything runs under the wrapper", async () => {
    seen.length = 0
    await Effect.runPromise(wrapped.run({ command: "sh", args: ["./gradlew", "test"], cwd: "." }))
    await Effect.runPromise(wrapped.run({ command: "sh", args: ["/repo/lark-bank/gradlew", "build"], cwd: "." }))
    await Effect.runPromise(wrapped.run({ command: "git", args: ["status"], cwd: "." }))
    expect(seen).toEqual([
      ["nix", "develop", ".#ci", "-c", "sh", "./gradlew", "-PlarkSource=/ws/deps/lark", "test"],
      ["nix", "develop", ".#ci", "-c", "sh", "/repo/lark-bank/gradlew", "-PlarkSource=/ws/deps/lark", "build"],
      ["nix", "develop", ".#ci", "-c", "git", "status"],
    ])
  })
})
