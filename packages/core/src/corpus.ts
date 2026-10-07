import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { runCheck } from "./check.ts"
import { Git } from "./git.ts"

// The public tamper corpus (spec 0002): committed cases, each a patch against
// a pack's fixture with what it should (or shouldn't) trigger. `gauntlet
// corpus` runs them all and reports the measured detection and false-positive
// rates. Checks skip the gates: every case is about what the integrity
// detectors see, which needs no build.

const Expected = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("positive"), fixture: Schema.String, finding: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("negative"), fixture: Schema.String }),
])
export type Expected = typeof Expected.Type
const decodeExpected = Schema.decodeUnknownOption(Schema.fromJsonString(Expected))

export interface CorpusCase {
  readonly pack: string
  readonly name: string
  readonly dir: string
  readonly expected: Expected
}

export interface CaseResult {
  readonly pack: string
  readonly name: string
  readonly kind: "positive" | "negative"
  /** Positive: the expected finding was reported. Negative: no integrity forbid fired. */
  readonly met: boolean
  /** The integrity findings the check reported, `kind check`. */
  readonly findings: ReadonlyArray<string>
  /** Set when the case couldn't be run at all (the patch no longer applies, for example). */
  readonly error?: string
}

export interface PackScore {
  readonly pack: string
  readonly positives: number
  readonly detected: number
  readonly negatives: number
  readonly falsePositives: number
}

export interface CorpusResult {
  readonly cases: ReadonlyArray<CaseResult>
  readonly packs: ReadonlyArray<PackScore>
  readonly total: PackScore
  /** Every case met its expectation. */
  readonly passed: boolean
}

/** Every case under `corpusDir/<pack>/<case>/`, sorted. A case without a readable expected.json is skipped with an error. */
export const readCorpus = (corpusDir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const cases: CorpusCase[] = []
    const problems: string[] = []
    const packs = (yield* fs.readDirectory(corpusDir)).sort()
    for (const pack of packs) {
      const packDir = path.join(corpusDir, pack)
      if (!(yield* fs.stat(packDir)).type.includes("Directory")) continue
      for (const name of (yield* fs.readDirectory(packDir)).sort()) {
        const dir = path.join(packDir, name)
        const text = yield* fs.readFileString(path.join(dir, "expected.json")).pipe(Effect.option)
        const expected = Option.flatMap(text, decodeExpected)
        if (Option.isNone(expected)) problems.push(`${pack}/${name}: no readable expected.json`)
        else cases.push({ pack, name, dir, expected: expected.value })
      }
    }
    return { cases, problems }
  })

/** Scores per pack and in total from the case results. */
export const score = (cases: ReadonlyArray<CaseResult>): Omit<CorpusResult, "cases"> => {
  const tally = (pack: string, cs: ReadonlyArray<CaseResult>): PackScore => ({
    pack,
    positives: cs.filter((c) => c.kind === "positive").length,
    detected: cs.filter((c) => c.kind === "positive" && c.met).length,
    negatives: cs.filter((c) => c.kind === "negative").length,
    falsePositives: cs.filter((c) => c.kind === "negative" && !c.met).length,
  })
  const packs = [...new Set(cases.map((c) => c.pack))].sort().map((p) => tally(p, cases.filter((c) => c.pack === p)))
  return { packs, total: tally("all", cases), passed: cases.every((c) => c.met && c.error === undefined) }
}

/**
 * Runs one case: the fixture's tracked files copied into a fresh repository and
 * committed as the base, the patch applied and committed, then a check of the
 * change with the gates skipped.
 */
const runCase = (c: CorpusCase, fixtureFiles: ReadonlyArray<{ readonly path: string; readonly text: string }>, outDir: string, gauntletVersion: string) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const git = yield* Git
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-corpus-" })
    for (const f of fixtureFiles) {
      yield* fs.makeDirectory(path.dirname(path.join(repo, f.path)), { recursive: true })
      yield* fs.writeFileString(path.join(repo, f.path), f.text)
    }
    yield* git.init(repo, "main")
    const base = yield* git.commitAll(repo, "base")
    const applied = yield* Effect.exit(git.applyPatch(repo, path.join(c.dir, "tamper.patch")))
    const result = { pack: c.pack, name: c.name, kind: c.expected.kind }
    if (applied._tag === "Failure") return { ...result, met: false, findings: [], error: "the patch no longer applies to the fixture" } satisfies CaseResult
    const head = yield* git.commitAll(repo, c.name)
    const { report } = yield* runCheck({ repo, baseRef: base, head, outDir: path.join(outDir, c.pack, c.name), gauntletVersion, record: false, skipGates: true })
    const findings = report.integrity.findings.map((f) => `${f.kind} ${f.check}`)
    const met = c.expected.kind === "positive"
      ? report.integrity.findings.some((f) => f.check === (c.expected as { finding: string }).finding)
      : !report.integrity.findings.some((f) => f.kind === "forbid")
    return { ...result, met, findings } satisfies CaseResult
  }))

/** Runs every case in the corpus against the fixtures in `fixturesDir` (tracked files of the repository at `repo`). */
export const runCorpus = (request: { readonly repo: string; readonly corpusDir: string; readonly fixturesDir: string; readonly outDir: string; readonly gauntletVersion: string }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const git = yield* Git
    const { cases, problems } = yield* readCorpus(request.corpusDir)
    const tracked = yield* git.listWorkingFiles(request.repo)
    const prefix = path.relative(request.repo, request.fixturesDir)
    const fixtures = new Map<string, { path: string; text: string }[]>()
    const filesOf = (fixture: string) =>
      Effect.gen(function*() {
        const cached = fixtures.get(fixture)
        if (cached) return cached
        const root = `${prefix}/${fixture}/`
        const files: { path: string; text: string }[] = []
        for (const p of tracked.filter((t) => t.startsWith(root))) files.push({ path: p.slice(root.length), text: yield* fs.readFileString(path.join(request.repo, p)) })
        fixtures.set(fixture, files)
        return files
      })
    const results: CaseResult[] = problems.map((p) => ({ pack: p.split("/")[0]!, name: p.split("/")[1]!.split(":")[0]!, kind: "positive" as const, met: false, findings: [], error: p }))
    for (const c of cases) {
      const files = yield* filesOf(c.expected.fixture)
      if (files.length === 0) {
        results.push({ pack: c.pack, name: c.name, kind: c.expected.kind, met: false, findings: [], error: `no fixture ${c.expected.fixture} in ${prefix}` })
        continue
      }
      results.push(yield* runCase(c, files, request.outDir, request.gauntletVersion))
    }
    return { cases: results, ...score(results) } satisfies CorpusResult
  })

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 1000) / 10}%`)

/** The measured rates per pack, then every case that missed its expectation. */
export const renderCorpus = (r: CorpusResult): string => {
  const row = (s: PackScore) => `| ${s.pack} | ${s.detected}/${s.positives} | ${pct(s.detected, s.positives)} | ${s.falsePositives}/${s.negatives} | ${pct(s.falsePositives, s.negatives)} |`
  const lines = [
    "| Pack | Detected | Detection rate | False positives | False-positive rate |",
    "| --- | --- | --- | --- | --- |",
    ...r.packs.map(row),
    row(r.total),
  ]
  const missed = r.cases.filter((c) => !c.met || c.error !== undefined)
  if (missed.length > 0) {
    lines.push("", "Cases that missed their expectation:")
    for (const c of missed) {
      lines.push(`- ${c.pack}/${c.name} (${c.kind}): ${c.error ?? (c.kind === "positive" ? "not detected" : `fired: ${c.findings.filter((f) => f.startsWith("forbid")).join(", ")}`)}`)
    }
  }
  return lines.join("\n")
}
