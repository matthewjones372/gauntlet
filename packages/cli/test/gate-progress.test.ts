import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { terminalGateProgress } from "../src/output.ts"

// Long checks show which gate is running and how long it took, in a terminal only.

const fakeStream = (tty: boolean) => {
  const written: string[] = []
  return { written, stream: { isTTY: tty, write: (s: string) => (written.push(s), true) } as unknown as NodeJS.WriteStream }
}

describe("gate progress in a terminal", () => {
  test("names the gate while it runs, then its outcome and time on one line", async () => {
    const { written, stream } = fakeStream(true)
    const p = terminalGateProgress(stream)!
    await Effect.runPromise(p.start("mutation"))
    await Effect.runPromise(p.end("mutation", "passed", 65_000))
    expect(written[0]).toBe("  mutation...")
    expect(written.at(-1)).toBe("\r\x1b[K  mutation: passed (1m 05s)\n")
  })

  test("nothing at all when stderr isn't a terminal", () => {
    expect(terminalGateProgress(fakeStream(false).stream)).toBeUndefined()
  })
})
