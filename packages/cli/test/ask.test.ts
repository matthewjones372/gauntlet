import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { PassThrough } from "node:stream"
import { terminalQuestion } from "../src/output.ts"

// `gauntlet setup` asks before installing anything, and only when someone is at a terminal.

const streams = (tty: boolean) => {
  const input = Object.assign(new PassThrough(), { isTTY: tty })
  const output = Object.assign(new PassThrough(), { isTTY: tty })
  return { input, output }
}

describe("terminal questions", () => {
  test("at a terminal, the person's answer comes back trimmed", async () => {
    const { input, output } = streams(true)
    const asked = Effect.runPromise(terminalQuestion(input, output)("Go ahead? [Y/n] "))
    input.write("  yes \n")
    expect(await asked).toEqual(Option.some("yes"))
  })

  test("without a terminal, nobody is asked", async () => {
    const { input, output } = streams(false)
    expect(await Effect.runPromise(terminalQuestion(input, output)("Go ahead? [Y/n] "))).toEqual(Option.none())
  })
})
