import type { PolicyIR } from "@gauntlet/ir"
import { Clock, Effect, FileSystem, Option, Path } from "effect"
import { BASELINE_PATH } from "./baseline-store.ts"
import { runCheck } from "./check.ts"
import { Git } from "./git.ts"
import { testPathMatcher } from "./integrity.ts"
import { PackRegistry } from "./pack-registry.ts"
import { POLICY_PATH, PolicySource } from "./policy-source.ts"
import type { Report } from "./report/schema.ts"

// `gauntlet selftest` makes the design test executable: can a known-bad
// change get past this policy? Each tamper fixture becomes a throwaway commit
// on top of the base, judged exactly as CI would judge it (policy from the
// base), and must be caught. A control run on an empty change comes first.

export const BUILT_IN_FIXTURES = [
  "deleted-test",
  "weakened-assertion",
  "added-skip",
  "added-suppression",
  "hardcoded-expected-value",
  "test-id-in-main",
  "edited-test-setup",
  "lowered-threshold",
  "edited-baseline",
  "fake-result-file",
] as const
export type BuiltInFixture = (typeof BUILT_IN_FIXTURES)[number]

export interface FileEdit {
  readonly path: string
  /** New content, or null to delete the file. */
  readonly content: string | null
}

/** What a project fixture (a patch in `.gauntlet/selftest/`) must lead to. */
export type Expectation =
  | { readonly kind: "blocked" }
  | { readonly kind: "tier"; readonly atLeast: "review" | "owner" }
  | { readonly kind: "finding"; readonly check: string }

export interface Tampering {
  readonly fixture: string
  readonly description: string
  readonly edits: ReadonlyArray<FileEdit>
}

export interface TamperContext {
  readonly files: ReadonlyArray<string>
  readonly read: (path: string) => Effect.Effect<Option.Option<string>>
  readonly ir: PolicyIR
  readonly isTestPath: (path: string) => boolean
}

export interface FixtureResult {
  readonly fixture: string
  readonly description: string
  readonly caught: boolean
  readonly why: string
  readonly tier: string
}

export interface SelftestResult {
  readonly base: string
  readonly control: { readonly tier: string; readonly wouldBlock: boolean; readonly executed: number; readonly reasons: ReadonlyArray<string> }
  readonly fixtures: ReadonlyArray<FixtureResult>
  /** Built-in fixtures with nothing to apply them to in this project (no tests yet, no baseline...). */
  readonly notApplicable: ReadonlyArray<string>
  readonly passed: boolean
}

const RANK = { auto: 0, skim: 1, review: 2, owner: 3 } as const
const executed = (r: Report) => r.checks.reduce((n, c) => n + (c.tests?.executed ?? 0), 0)
const hasFinding = (r: Report, check: string) => r.integrity.findings.some((f) => f.check === check && f.kind !== "flag")
const nominated = (r: Report, rule: string) => r.decision.nominations.some((n) => n.rule === rule)

/** How each built-in fixture counts as caught. */
/**
 * Fixtures whose verdict needs no gate to run: they're caught by a static
 * integrity detector (skips, suppressions, test references in main code,
 * weakened assertions) or by the policy decision itself (a lowered threshold,
 * an edited baseline). Their checks skip the gates, which keeps selftest fast
 * without changing what it proves. A deleted test stays a full check, since
 * some packs find it only from the tests that ran.
 */
const CAUGHT_WITHOUT_EXECUTION: ReadonlySet<string> = new Set(["added-skip", "added-suppression", "test-id-in-main", "weakened-assertion", "lowered-threshold", "edited-baseline"])

const EXPECT: Record<BuiltInFixture, (r: Report, control: Report) => { caught: boolean; why: string }> = {
  "deleted-test": (r) => ({ caught: hasFinding(r, "deleted-tests"), why: "a deleted-tests forbid" }),
  "weakened-assertion": (r) => ({ caught: hasFinding(r, "weakened-assertions"), why: "a weakened-assertions forbid" }),
  "added-skip": (r) => ({ caught: hasFinding(r, "new-skips"), why: "a new-skips forbid" }),
  "added-suppression": (r) => ({ caught: hasFinding(r, "new-suppressions"), why: "a new-suppressions forbid" }),
  "hardcoded-expected-value": (r) => ({ caught: r.decision.wouldBlock, why: "a failing gate (tests, mutation or a ratchet)" }),
  "test-id-in-main": (r) => ({ caught: hasFinding(r, "test-refs-in-main"), why: "a test-refs-in-main forbid" }),
  "edited-test-setup": (r, control) => ({
    caught: nominated(r, "protected-changed") && executed(r) >= executed(control),
    why: "a protected-change nomination with every test still running",
  }),
  "lowered-threshold": (r) => ({ caught: r.policy.origin === "base" && r.decision.tier === "owner", why: "judged by the base policy, with an owner" }),
  "edited-baseline": (r) => ({ caught: r.decision.tier === "owner", why: "an owner" }),
  "fake-result-file": (r, control) => ({
    caught: executed(r) === executed(control) && !JSON.stringify(r.checks).includes("gauntlet-fake"),
    why: "the planted report ignored and the real tests counted",
  }),
}

const expectProject = (e: Expectation) => (r: Report): { caught: boolean; why: string } => {
  switch (e.kind) {
    case "blocked": return { caught: r.decision.wouldBlock, why: "a blocking result" }
    case "tier": return { caught: RANK[r.decision.tier] >= RANK[e.atLeast], why: `tier ${e.atLeast} or higher` }
    case "finding": return { caught: r.integrity.findings.some((f) => f.check === e.check) || r.violations.some((v) => v.ruleId === e.check), why: `a ${e.check} finding` }
  }
}

/** Reads `Expect:` and `Description:` headers from the text before a patch's first diff. */
export const parseProjectFixture = (name: string, text: string): { description: string; expect: Expectation } => {
  const head = text.split(/^diff --git /m)[0] ?? ""
  const description = /^Description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? name
  const raw = /^Expect:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? "blocked"
  const tier = /^tier\s*>=\s*(review|owner)$/.exec(raw)
  const finding = /^finding\s+([\w./-]+)$/.exec(raw)
  const expect: Expectation = tier ? { kind: "tier", atLeast: tier[1] as "review" | "owner" } : finding ? { kind: "finding", check: finding[1]! } : { kind: "blocked" }
  return { description, expect }
}

const FAKE_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="gauntlet-fake" tests="999" failures="0" errors="0" skipped="0">${Array.from({ length: 3 }, (_, i) => `<testcase classname="gauntlet.Fake" name="passes${i}"/>`).join("")}</testsuite>\n`

/** Tamperings that need no language knowledge. */
export const genericTamperings = (ctx: TamperContext) =>
  Effect.gen(function*() {
    const out: Tampering[] = []
    const policy = yield* ctx.read(POLICY_PATH)
    if (Option.isSome(policy)) {
      const lowered = policy.value.replace(/(>=\s*)(\d+(\.\d+)?)%/, "$10%")
      const edited = lowered !== policy.value ? lowered : policy.value.includes("mode enforce") ? policy.value.replace("mode enforce", "mode shadow") : `${policy.value}\n// selftest\n`
      out.push({ fixture: "lowered-threshold", description: "the change lowers a threshold in the policy", edits: [{ path: POLICY_PATH, content: edited }] })
    }
    const baseline = yield* ctx.read(BASELINE_PATH)
    if (Option.isSome(baseline)) {
      const lowered = baseline.value.replace(/("value":\s*)(\d+(\.\d+)?)/, "$10")
      out.push({ fixture: "edited-baseline", description: "the change lowers a value in the baseline", edits: [{ path: BASELINE_PATH, content: lowered === baseline.value ? `${baseline.value} ` : lowered }] })
    }
    if (ctx.ir.suites.some((s) => s.kind === "suite")) {
      out.push({
        fixture: "fake-result-file",
        description: "the change plants passing test reports where tools usually write them",
        edits: ["build/test-results/test/TEST-gauntlet-fake.xml", "target/surefire-reports/TEST-gauntlet-fake.xml", "junit.xml", "test-results/gauntlet-fake.xml"]
          .map((p) => ({ path: p, content: FAKE_JUNIT })),
      })
    }
    return out
  })

export interface SelftestRequest {
  readonly repo: string
  /** The commit fixtures are applied to. Defaults to HEAD. */
  readonly base?: string
  readonly only?: ReadonlyArray<string>
  readonly gauntletVersion: string
  readonly outDir: string
  /** Told each step as it starts and ends, so a long run shows it's moving. */
  readonly progress?: (line: string) => Effect.Effect<void>
}

/** A duration for people: 850ms, 12s, 3m 05s. */
export const elapsed = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`

/** The tamperings that apply to a project, from the built-in generic set and the policy's packs. */
const tamperingsFor = (ctx: TamperContext) =>
  Effect.gen(function*() {
    const registry = yield* PackRegistry
    return [
      ...(yield* genericTamperings(ctx)),
      ...(yield* Effect.forEach(registry.packs.filter((p) => ctx.ir.packs.includes(p.spec.name) && p.tamper), (p) => p.tamper!(ctx))).flat(),
    ]
  })

export interface SelftestPlan {
  readonly fixtures: ReadonlyArray<{ readonly fixture: string; readonly description: string; readonly paths: ReadonlyArray<string> }>
  /** Built-in fixtures this policy gives nothing to apply to, so selftest can't prove they're caught. */
  readonly notApplicable: ReadonlyArray<string>
}

/**
 * A dry run of `gauntlet selftest`: which built-in fixtures apply to the
 * project under a policy, without running anything. The authoring agent uses
 * it to find (and cite) gaps, and to check that a proposal closes one.
 */
export const planSelftest = (request: { readonly repo: string; readonly base?: string; readonly ir: PolicyIR }) =>
  Effect.gen(function*() {
    const git = yield* Git
    const base = yield* git.revParse(request.repo, request.base ?? "HEAD")
    const files = yield* git.listTree(request.repo, base)
    const read = (p: string) => git.show(request.repo, base, p).pipe(Effect.orElseSucceed(() => Option.none<string>()))
    const tamperings = yield* tamperingsFor({ files, read, ir: request.ir, isTestPath: testPathMatcher(request.ir) })
    const builtIn = BUILT_IN_FIXTURES.flatMap((fixture) => {
      const t = [...tamperings].reverse().find((x) => x.fixture === fixture)
      return t ? [{ fixture, description: t.description, paths: t.edits.map((e) => e.path).sort() }] : []
    })
    return { fixtures: builtIn, notApplicable: BUILT_IN_FIXTURES.filter((f) => !builtIn.some((b) => b.fixture === f)) } satisfies SelftestPlan
  })

export const runSelftest = (request: SelftestRequest) =>
  Effect.gen(function*() {
    const git = yield* Git
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const base = yield* git.revParse(request.repo, request.base ?? "HEAD")
    const loaded = yield* (yield* PolicySource).load({ repo: request.repo, policyRef: base })
    const ir = loaded.compiled.ir
    const files = yield* git.listTree(request.repo, base)
    const read = (p: string) => git.show(request.repo, base, p).pipe(Effect.orElseSucceed(() => Option.none<string>()))
    const ctx: TamperContext = { files, read, ir, isTestPath: testPathMatcher(ir) }

    // A commit on top of the base with the edits applied, made in a scratch worktree.
    const commitWith = (name: string, apply: (dir: string) => Effect.Effect<void, unknown>) =>
      Effect.scoped(Effect.gen(function*() {
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-selftest-" })
        const dir = path.join(root, "work")
        yield* Effect.acquireRelease(git.addWorktree(request.repo, dir, base), () => git.removeWorktree(request.repo, dir).pipe(Effect.ignore))
        yield* apply(dir)
        return yield* git.commitAll(dir, `gauntlet selftest: ${name}`)
      }))
    const applyEdits = (edits: ReadonlyArray<FileEdit>) => (dir: string) =>
      Effect.forEach(edits, (e) =>
        e.content === null
          ? fs.remove(path.join(dir, e.path), { force: true })
          : fs.makeDirectory(path.dirname(path.join(dir, e.path)), { recursive: true }).pipe(Effect.flatMap(() => fs.writeFileString(path.join(dir, e.path), e.content!)))
      , { discard: true })
    const judge = (name: string, head: string, skipGates = false) =>
      runCheck({ repo: request.repo, policyRef: base, head, outDir: path.join(request.outDir, name), gauntletVersion: request.gauntletVersion, record: false, skipGates })

    const say = request.progress ?? (() => Effect.void)
    const timed = <A, E, R>(e: Effect.Effect<A, E, R>) =>
      Effect.gen(function*() {
        const start = yield* Clock.currentTimeMillis
        const a = yield* e
        return { a, ms: (yield* Clock.currentTimeMillis) - start }
      })

    yield* say("Checking an empty change first (the control), so every fixture has something to compare with...")
    const controlRun = yield* timed(Effect.gen(function*() {
      const controlSha = yield* commitWith("control", () => Effect.void)
      return (yield* judge("control", controlSha)).report
    }))
    const control = controlRun.a
    yield* say(`  control: ${control.decision.tier}, ${executed(control)} tests ran (${elapsed(controlRun.ms)})`)

    const tamperings = yield* tamperingsFor(ctx)
    const projectFiles = files.filter((f) => f.startsWith(".gauntlet/selftest/") && f.endsWith(".patch")).sort()
    const wanted = (name: string) => request.only === undefined || request.only.includes(name)

    // Built-in fixtures in a fixed order; a pack's version wins over a generic one of the same name.
    // Each runs in its own worktree and output directory, so two run at once; results keep the order.
    const builtIn = BUILT_IN_FIXTURES.flatMap((fixture) => {
      const t = [...tamperings].reverse().find((x) => x.fixture === fixture)
      return t && wanted(fixture) ? [{ fixture, t }] : []
    })
    const total = builtIn.length + projectFiles.filter((f) => wanted(f.slice(".gauntlet/selftest/".length).replace(/\.patch$/, ""))).length
    let done = 0
    const finished = (fixture: string, caught: boolean, tier: string, ms: number) =>
      say(`  ${caught ? "caught" : "MISSED"}  ${fixture} (${tier}, ${elapsed(ms)})  [${++done}/${total}]`)
    if (total > 0) yield* say(`Running ${total} tamper fixture${total === 1 ? "" : "s"}, two at a time; each is a full check:`)
    const results: FixtureResult[] = [...yield* Effect.forEach(builtIn, ({ fixture, t }) =>
      Effect.gen(function*() {
        yield* say(`  running ${fixture}...`)
        const run = yield* timed(Effect.gen(function*() {
          const sha = yield* commitWith(fixture, applyEdits(t.edits))
          return (yield* judge(fixture, sha, CAUGHT_WITHOUT_EXECUTION.has(fixture))).report
        }))
        const report = run.a
        const verdict = EXPECT[fixture](report, control)
        yield* finished(fixture, verdict.caught, report.decision.tier, run.ms)
        return { fixture, description: t.description, tier: report.decision.tier, caught: verdict.caught, why: verdict.caught ? `caught by ${verdict.why}` : `expected ${verdict.why}` } satisfies FixtureResult
      }), { concurrency: 2 })]
    for (const file of projectFiles) {
      const name = file.slice(".gauntlet/selftest/".length).replace(/\.patch$/, "")
      if (!wanted(name)) continue
      const text = Option.getOrElse(yield* read(file), () => "")
      const fixture = parseProjectFixture(name, text)
      const patch = path.join(request.outDir, `${name}.patch`)
      yield* fs.makeDirectory(request.outDir, { recursive: true })
      yield* fs.writeFileString(patch, text)
      yield* say(`  running ${name}...`)
      const start = yield* Clock.currentTimeMillis
      const applied = yield* Effect.exit(commitWith(name, (dir) => git.applyPatch(dir, patch)))
      if (applied._tag === "Failure") {
        yield* finished(name, false, "-", (yield* Clock.currentTimeMillis) - start)
        results.push({ fixture: name, description: fixture.description, tier: "-", caught: false, why: "the patch no longer applies to the base" })
        continue
      }
      const report = (yield* judge(name, applied.value)).report
      const verdict = expectProject(fixture.expect)(report)
      yield* finished(name, verdict.caught, report.decision.tier, (yield* Clock.currentTimeMillis) - start)
      results.push({ fixture: name, description: fixture.description, tier: report.decision.tier, caught: verdict.caught, why: verdict.caught ? `caught by ${verdict.why}` : `expected ${verdict.why}` })
    }

    const covered = new Set(tamperings.map((t) => t.fixture))
    return {
      base,
      control: { tier: control.decision.tier, wouldBlock: control.decision.wouldBlock, executed: executed(control), reasons: control.decision.nominations.filter((n) => n.blocking).map((n) => n.reason) },
      fixtures: results,
      notApplicable: BUILT_IN_FIXTURES.filter((f) => wanted(f) && !covered.has(f)),
      passed: !control.decision.wouldBlock && results.every((r) => r.caught),
    } satisfies SelftestResult
  })

/** The result for a terminal: one aligned line per fixture, the long descriptions only for what got through. */
export const renderSelftestText = (r: SelftestResult): string => {
  const lines = [`Gauntlet selftest at ${r.base.slice(0, 12)}`, ""]
  if (r.control.wouldBlock) {
    lines.push("The policy blocks an empty change, so no fixture result means anything yet. Fix these first:", ...r.control.reasons.map((x) => `  - ${x}`), "")
  } else {
    lines.push(`Control (an empty change): ${r.control.tier}, ${r.control.executed} tests ran.`, "")
  }
  const name = Math.max(0, ...r.fixtures.map((f) => f.fixture.length))
  const tier = Math.max(0, ...r.fixtures.map((f) => f.tier.length))
  for (const f of r.fixtures) {
    lines.push(`  ${f.caught ? "caught" : "MISSED"}  ${f.fixture.padEnd(name)}  ${f.tier.padEnd(tier)}  ${f.why.replace(/^caught by /, "")}`)
    if (!f.caught) lines.push(`          ${" ".repeat(name)}  ${" ".repeat(tier)}  ${f.description}`)
  }
  if (r.notApplicable.length > 0) lines.push("", `Not applicable to this project: ${r.notApplicable.join(", ")}.`)
  const caught = r.fixtures.filter((f) => f.caught).length
  lines.push("", r.passed
    ? `All ${caught} tamperings were caught.`
    : `${caught} of ${r.fixtures.length} tamperings were caught. Each MISSED line is a gap in this policy or its suites.`, "")
  return lines.join("\n")
}

export const renderSelftest = (r: SelftestResult): string => {
  const lines = [`## Gauntlet selftest at ${r.base.slice(0, 12)}`, ""]
  if (r.control.wouldBlock) {
    lines.push("**The policy blocks an empty change**, so no fixture result means anything yet. Fix these first:", "", ...r.control.reasons.map((x) => `- ${x}`), "")
  } else {
    lines.push(`Control (empty change): tier ${r.control.tier}, ${r.control.executed} tests ran.`, "")
  }
  lines.push("| Fixture | Caught | Tier | Why |", "| --- | --- | --- | --- |")
  for (const f of r.fixtures) lines.push(`| ${f.fixture} | ${f.caught ? "yes" : "**no**"} | ${f.tier} | ${f.why}: ${f.description} |`)
  if (r.notApplicable.length > 0) lines.push("", `Not applicable to this project: ${r.notApplicable.join(", ")}.`)
  lines.push("", r.passed ? "Every tampering was caught." : "Some tampering got through. Each row marked **no** is a gap in this policy or its suites.", "")
  return lines.join("\n")
}
