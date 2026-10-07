import { Effect, Option } from "effect"
import { type DoctorCheck, PackRegistry } from "./pack-registry.ts"
import { PolicySource } from "./policy-source.ts"
import { ProcessRunner } from "./process-runner.ts"

// `gauntlet doctor`: can this build run here? Embedded assets (grammars, init
// scripts) are checked by each pack; tools are looked up on PATH. Tools a
// project's packs need are listed as optional when the policy can't be read.

const TOOLS: Readonly<Record<string, ReadonlyArray<{ readonly command: string; readonly args: ReadonlyArray<string> }>>> = {
  jvm: [{ command: "java", args: ["-version"] }],
  typescript: [{ command: "bun", args: ["--version"] }, { command: "node", args: ["--version"] }],
  python: [{ command: "python3", args: ["--version"] }, { command: "uv", args: ["--version"] }],
  go: [{ command: "go", args: ["version"] }, { command: "golangci-lint", args: ["--version"] }],
  scala: [{ command: "sbt", args: ["--script-version"] }, { command: "java", args: ["-version"] }],
  // The build tool is the clojure CLI or lein, whichever the project uses; the gates say which is missing.
  clojure: [{ command: "java", args: ["-version"] }, { command: "clj-kondo", args: ["--version"] }],
  rust: [{ command: "cargo", args: ["--version"] }, { command: "cargo", args: ["nextest", "--version"] }, { command: "cargo", args: ["llvm-cov", "--version"] }, { command: "cargo", args: ["mutants", "--version"] }],
}

const probe = (command: string, args: ReadonlyArray<string>, repo: string) =>
  Effect.gen(function*() {
    const r = yield* Effect.exit((yield* ProcessRunner).run({ command, args, cwd: repo, env: {} }))
    if (r._tag === "Failure" || r.value.exitCode !== 0) return Option.none<string>()
    return Option.some(`${r.value.stdout}${r.value.stderr}`.trim().split("\n")[0] ?? "")
  })

export const runDoctor = (repo: string) =>
  Effect.gen(function*() {
    const registry = yield* PackRegistry
    const checks: DoctorCheck[] = []
    const git = yield* probe("git", ["--version"], repo)
    checks.push({ what: "git", ok: Option.isSome(git), detail: Option.getOrElse(git, () => "not found on PATH; Gauntlet needs git") })
    for (const p of registry.packs) checks.push(...(p.doctor?.() ?? []))
    const policy = yield* Effect.option((yield* PolicySource).load({ repo }))
    const used = Option.match(policy, { onNone: () => registry.packs.map((p) => p.spec.name), onSome: (l) => l.compiled.ir.packs })
    checks.push({ what: "policy", ok: true, optional: true, detail: Option.match(policy, { onNone: () => "no readable .gauntlet/policy.gx here", onSome: (l) => `uses ${l.compiled.ir.packs.join(", ")}, mode ${l.compiled.ir.mode}` }) })
    for (const pack of used) {
      for (const tool of TOOLS[pack] ?? []) {
        const found = yield* probe(tool.command, tool.args, repo)
        checks.push({ what: `${pack}: ${tool.command}`, ok: Option.isSome(found), optional: true, detail: Option.getOrElse(found, () => "not found on PATH") })
      }
    }
    return checks
  })

export const renderDoctor = (checks: ReadonlyArray<DoctorCheck>): string => {
  const width = Math.max(...checks.map((c) => c.what.length))
  return checks.map((c) => `${c.ok ? "ok  " : c.optional ? "--  " : "FAIL"}  ${c.what.padEnd(width)}  ${c.detail}`).join("\n")
}
