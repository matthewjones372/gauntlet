import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plainSummary, renderMarkdown, type Report, Reporter, ReporterLive } from "../src/index.ts"

// The report names files as links to the commit on GitHub when it knows the
// repository, says each thing in plain words, counts several failed checks
// instead of listing them, and says one file's deletion once.

const golden = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "golden", `${name}.report.json`), "utf8")) as Report
const REPO = "https://github.com/acme/shop"
const nomination = (rule: string, reason: string, blocking = false) => ({ tier: "review", reason, rule, blocking })

describe("the report's files and wording", () => {
  test("files link to the judged commit when the repository is known, and are plain paths otherwise", () => {
    const r = golden("owner-policy-edit")
    const linked = renderMarkdown(r, { repoUrl: REPO })
    expect(linked).toContain(`[\`src/main/money/Fx.kt\`](${REPO}/blob/${r.policy.headSha}/src/main/money/Fx.kt)`)
    expect(linked).toContain(`It changes [\`build.gradle.kts\`](${REPO}/blob/${r.policy.headSha}/build.gradle.kts), which is protected.`)
    expect(renderMarkdown(r)).not.toContain(REPO)
  })

  test("a finding links to its line; a deleted file links to the base", () => {
    const r = golden("owner-policy-edit")
    const withMore: Report = {
      ...r,
      facts: { ...r.facts, files: [...r.facts.files, { path: "src/test/OldTest.kt", status: "deleted", added: 0, removed: 9 }] },
      decision: {
        ...r.decision,
        nominations: [
          ...r.decision.nominations,
          nomination("integrity-flag", ".catch() near changed code swallows every rejection. (src/main/App.kt:14)"),
          nomination("protected-changed", "src/test/OldTest.kt is a protected test (tests) the change deletes; it runs as the change has it and needs review."),
        ],
      },
    } as Report
    const text = plainSummary(withMore, { repoUrl: REPO }).join("\n")
    expect(text).toContain(`In [\`src/main/App.kt:14\`](${REPO}/blob/${r.policy.headSha}/src/main/App.kt#L14): .catch() near changed code swallows every rejection.`)
    expect(text).toContain(`It deletes the protected test [\`src/test/OldTest.kt\`](${REPO}/blob/${r.policy.baseSha}/src/test/OldTest.kt), so a person needs to check that's meant.`)
  })

  test("a test deleted with its code is said once", () => {
    const r = golden("owner-policy-edit")
    const both: Report = {
      ...r,
      decision: {
        ...r.decision,
        nominations: [
          nomination("integrity-flag", "Test file src/test/BenchTest.kt was removed along with src/main/Bench.kt, the code it tested. Check the feature was meant to go. (src/test/BenchTest.kt)"),
          nomination("protected-changed", "src/test/BenchTest.kt is a protected test (tests) the change deletes; it runs as the change has it and needs review."),
        ],
      },
    } as Report
    const text = plainSummary(both).join("\n")
    expect(text).toContain("Test file src/test/BenchTest.kt was removed along with src/main/Bench.kt")
    expect(text).not.toContain("It deletes the protected test")
  })

  test("several failed checks are counted in the headline, and a budget is named as one", () => {
    const r = golden("failing-enforce")
    const budgets: Report = {
      ...r,
      decision: {
        ...r.decision,
        nominations: [
          nomination("gate-failed", "budget hook failed: p95 1400ms is over 1000ms", true),
          nomination("gate-failed", "budget startup failed: the budget's command exited with 1", true),
        ],
      },
    } as Report
    const text = plainSummary(budgets).join("\n")
    expect(text).toStartWith("> [!CAUTION]\n> **Blocked** because 2 checks failed.")
    expect(text).toContain("> 1. The performance budget **hook** failed: p95 1400ms is over 1000ms.")
    expect(text).toContain("> 2. The performance budget **startup** failed: the budget's command exited with 1.")
  })

  test("a test edited under protection says Gauntlet ran the edited version", () => {
    const r = golden("owner-policy-edit")
    const edited: Report = {
      ...r,
      decision: { ...r.decision, nominations: [nomination("protected-changed", "src/test/FxTest.kt is a protected test (tests) the change edits; it runs as the change has it and needs review.")] },
    } as Report
    expect(plainSummary(edited).join("\n")).toContain("It edits the protected test `src/test/FxTest.kt`. Gauntlet ran the edited version, so a person needs to check the edit is right.")
  })

  test("on GitHub Actions the written report links its files", async () => {
    const r = golden("owner-policy-edit")
    const dir = mkdtempSync(join(tmpdir(), "report-"))
    const saved = { server: process.env.GITHUB_SERVER_URL, repo: process.env.GITHUB_REPOSITORY }
    process.env.GITHUB_SERVER_URL = "https://github.com"
    process.env.GITHUB_REPOSITORY = "acme/shop"
    try {
      await Effect.runPromise(Reporter.use((rep) => rep.write(dir, r, [], { startedAt: "", finishedAt: "", durationsMs: {} })).pipe(
        Effect.provide(ReporterLive.pipe(Layer.provide(BunServices.layer))),
      ))
    } finally {
      if (saved.server === undefined) delete process.env.GITHUB_SERVER_URL
      else process.env.GITHUB_SERVER_URL = saved.server
      if (saved.repo === undefined) delete process.env.GITHUB_REPOSITORY
      else process.env.GITHUB_REPOSITORY = saved.repo
    }
    expect(readFileSync(join(dir, "gauntlet-report.md"), "utf8")).toContain(`(${REPO}/blob/${r.policy.headSha}/src/main/money/Fx.kt)`)
  })
})
