import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Sink, Stdio, Stream } from "effect"
import { appLayer } from "../../cli/src/index.ts"
import { hookCli } from "../../cli/test/agent-harness.ts"
import { baseRepo } from "../../cli/test/harness.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { ATTEMPTS_URI, mcpServer } from "../src/index.ts"

// The agent hooks' outcomes as an MCP resource (ADR 0026): an orchestrator
// reads blocked, exhausted or reported-blocked per branch as JSON.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

/** Raw JSON-RPC requests to the server over a test Stdio; responses by id. */
const rpc = async (repo: string, calls: ReadonlyArray<{ method: string; params?: unknown }>) => {
  const requests = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, ...(c.params ? { params: c.params } : {}) })),
  ]
  const responses = new Map<number, any>()
  let buffer = ""
  const program = Effect.gen(function*() {
    const done = yield* Deferred.make<void>()
    const stdio = Stdio.layerTest({
      stdin: Stream.fromIterable(requests.map((r) => new TextEncoder().encode(`${JSON.stringify(r)}\n`))).pipe(Stream.concat(Stream.fromEffectDrain(Deferred.await(done)))),
      stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.gen(function*() {
        buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines.filter((l) => l.trim() !== "")) {
          const m = JSON.parse(line)
          if (typeof m.id === "number") responses.set(m.id, m)
        }
        if (responses.size >= calls.length + 1) yield* Deferred.succeed(done, undefined)
      })),
    })
    const server = mcpServer({ repo, gauntletVersion: "0.1.0-test", env: {} }).pipe(Layer.provide(stdio))
    yield* Layer.launch(server).pipe(Effect.raceFirst(Deferred.await(done).pipe(Effect.andThen(Effect.sleep("10 millis")))))
  })
  await Effect.runPromiseExit(program.pipe(Effect.provide(appLayer([scriptPack]))))
  return (i: number) => responses.get(i + 1)?.result
}

describe("the attempts resource", () => {
  test("is listed, and reads as JSON with each branch's outcome", async () => {
    const { r } = baseRepo()
    repos.push(r)
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    for (let i = 0; i < 4; i++) await hookCli(["hook", "stop"], JSON.stringify({ cwd: r.dir, hook_event_name: "SubagentStop" }))
    const result = await rpc(r.dir, [{ method: "resources/list" }, { method: "resources/read", params: { uri: ATTEMPTS_URI } }])
    expect(result(0).resources.map((x: { uri: string }) => x.uri)).toContain("gauntlet://attempts")
    const content = result(1).contents[0]
    expect(content.mimeType).toBe("application/json")
    const { branches } = JSON.parse(content.text)
    expect(branches).toHaveLength(1)
    expect(branches[0]).toMatchObject({ status: "exhausted", branch: "feature", attempts: { unchanged: 4, total: 4 }, limits: { unchanged: 3, total: 8 }, state: "ok" })
    expect(branches[0].findings).toContain("test unit svc.AddTest.add")
  }, 120_000)

  test("is empty before any hook has blocked", async () => {
    const { r } = baseRepo()
    repos.push(r)
    const result = await rpc(r.dir, [{ method: "resources/read", params: { uri: ATTEMPTS_URI } }])
    expect(JSON.parse(result(0).contents[0].text)).toEqual({ branches: [] })
  }, 60_000)
})
