import { Effect, FileSystem, Schema } from "effect"
import { type AttemptLimits, attemptLocation, nextAttempt, readAttempts, reportedBlocked, writeAttempts } from "./attempts.ts"
import { Git } from "./git.ts"
import { ProcessRunner } from "./process-runner.ts"

// Tampering with the hooks' attempt record (ADR 0026): a tamper category of
// its own, since it isn't a commit. Each case records a legitimate state,
// tampers with it the way an agent with a shell could, and requires the next
// blocked stop to be exhausted: never a fresh start. The control, with no
// tampering, must still block. `gauntlet selftest` and the stop-hook corpus
// both run these.

export const STATE_TAMPERS = ["delete-record", "corrupt-record", "delete-witness", "forge-count"] as const
export type StateTamper = (typeof STATE_TAMPERS)[number]

export const STATE_TAMPER_DESCRIPTIONS: Record<StateTamper | "none", string> = {
  "none": "no tampering: the next blocked stop is attempt 1",
  "delete-record": "the attempt record is deleted",
  "corrupt-record": "the attempt record is overwritten with something that doesn't parse",
  "delete-witness": "the witness ref is deleted, leaving the record",
  "forge-count": "the record's counts are rewritten to 0 without its witness",
}

export interface StateTamperResult {
  readonly tamper: StateTamper | "none"
  readonly description: string
  /** Tampered: the next blocked stop was exhausted. Control: it was blocked. */
  readonly caught: boolean
  readonly status: string
  readonly state: string
}

const ATTEMPT = { fingerprint: "selftest", findings: ["gate selftest failed"], reasons: ["gate-failed: selftest failed"] }

/**
 * One case in a scratch repository: a branch with a legitimate record and no
 * attempts used yet, the tampering, then one blocked stop under `limits`.
 */
export const runStateTamper = (tamper: StateTamper | "none", limits: AttemptLimits) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const runner = yield* ProcessRunner
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-attempts-" })
    yield* (yield* Git).init(repo, "main")
    const branch = "main"
    // A record with no attempts used, as a matching report_blocked leaves it: the control's next stop is attempt 1.
    yield* writeAttempts(repo, reportedBlocked(branch, { kind: "fresh" }, ATTEMPT, limits, "selftest"))
    const at = yield* attemptLocation(repo, branch)
    switch (tamper) {
      case "none": break
      case "delete-record": yield* fs.remove(at.file); break
      case "corrupt-record": yield* fs.writeFileString(at.file, "{ not json"); break
      case "delete-witness": yield* runner.run({ command: "git", args: ["update-ref", "-d", at.ref], cwd: repo }); break
      case "forge-count": {
        const record = JSON.parse(yield* fs.readFileString(at.file)) as Record<string, unknown>
        yield* fs.writeFileString(at.file, `${JSON.stringify({ ...record, attempts: { unchanged: 0, total: 0 }, status: "blocked", reportedReason: undefined }, null, 2)}\n`)
        break
      }
    }
    const next = nextAttempt(branch, yield* readAttempts(repo, branch), ATTEMPT, limits)
    return {
      tamper,
      description: STATE_TAMPER_DESCRIPTIONS[tamper],
      caught: tamper === "none" ? next.status === "blocked" : next.status === "exhausted",
      status: next.status,
      state: next.state,
    } satisfies StateTamperResult
  }))

/** The control and every tampering. */
export const runStateTampers = (limits: AttemptLimits) => Effect.forEach(["none", ...STATE_TAMPERS] as const, (t) => runStateTamper(t, limits))

const CorpusCase = Schema.Struct({ tamper: Schema.Literals(["none", ...STATE_TAMPERS]), expect: Schema.Literals(["blocked", "exhausted"]) })
const decodeCase = Schema.decodeUnknownOption(Schema.fromJsonString(CorpusCase))

export interface StopHookCaseResult {
  readonly name: string
  readonly tamper: string
  readonly expect: string
  readonly status: string
  readonly met: boolean
  readonly error?: string
}

/** `corpus/stop-hook/<case>/case.json`: each case's tampering and the outcome it must lead to, under the default limits. */
export const runStopHookCorpus = (dir: string, limits: AttemptLimits) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const results: StopHookCaseResult[] = []
    for (const name of (yield* fs.readDirectory(dir)).sort()) {
      const text = yield* fs.readFileString(`${dir}/${name}/case.json`).pipe(Effect.option)
      const parsed = text._tag === "Some" ? decodeCase(text.value) : text
      if (parsed._tag === "None") {
        results.push({ name, tamper: "-", expect: "-", status: "-", met: false, error: "no readable case.json" })
        continue
      }
      const r = yield* runStateTamper(parsed.value.tamper, limits)
      results.push({ name, tamper: parsed.value.tamper, expect: parsed.value.expect, status: r.status, met: r.status === parsed.value.expect })
    }
    return { cases: results, passed: results.length > 0 && results.every((r) => r.met) }
  })

export const renderStopHookCorpus = (r: { readonly cases: ReadonlyArray<StopHookCaseResult>; readonly passed: boolean }) =>
  [
    "| Case | Tampering | Expected | Got |",
    "| --- | --- | --- | --- |",
    ...r.cases.map((c) => `| ${c.name} | ${c.tamper} | ${c.expect} | ${c.error ?? c.status}${c.met ? "" : " **(missed)**"} |`),
    "",
    r.passed ? `All ${r.cases.length} cases met their expectation.` : "Some cases missed their expectation.",
  ].join("\n")
