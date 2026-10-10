import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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

  test("on a pull request, a changed file links to its change in Files changed; a line to that line", () => {
    const r = golden("owner-policy-edit")
    const changed: Report = {
      ...r,
      facts: { ...r.facts, files: [{ path: "src/main/money/Fx.kt", status: "modified", added: 2, removed: 1 }, { path: "src/test/OldTest.kt", status: "deleted", added: 0, removed: 9 }] },
      decision: { ...r.decision, nominations: [...r.decision.nominations, nomination("integrity-flag", "A new @Disabled skips a test. (src/main/money/Fx.kt:7)"), nomination("protected-changed", "src/test/OldTest.kt is a protected test (tests) the change deletes; it runs as the change has it and needs review.")] },
    } as Report
    const text = plainSummary(changed, { repoUrl: REPO, pullRequest: 42 }).join("\n")
    const anchor = (p: string) => new Bun.CryptoHasher("sha256").update(p).digest("hex")
    expect(text).toContain(`[\`src/main/money/Fx.kt\`](${REPO}/pull/42/files#diff-${anchor("src/main/money/Fx.kt")})`)
    expect(text).toContain(`[\`src/main/money/Fx.kt:7\`](${REPO}/pull/42/files#diff-${anchor("src/main/money/Fx.kt")}R7)`)
    expect(text).toContain(`[\`src/test/OldTest.kt\`](${REPO}/pull/42/files#diff-${anchor("src/test/OldTest.kt")})`)
    // A file the change doesn't touch has no diff to link to: it links to the file.
    expect(text).toContain(`[\`build.gradle.kts\`](${REPO}/blob/${r.policy.headSha}/build.gradle.kts)`)
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

  test("on GitHub Actions the written report links its files to the pull request's diff", async () => {
    const g = golden("owner-policy-edit")
    const r: Report = { ...g, facts: { ...g.facts, files: [{ path: "src/main/money/Fx.kt", status: "modified", added: 2, removed: 1 }] } } as Report
    const dir = mkdtempSync(join(tmpdir(), "report-"))
    const saved = { server: process.env.GITHUB_SERVER_URL, repo: process.env.GITHUB_REPOSITORY, event: process.env.GITHUB_EVENT_PATH }
    process.env.GITHUB_SERVER_URL = "https://github.com"
    process.env.GITHUB_REPOSITORY = "acme/shop"
    // A comment on a pull request: the event names it as an issue that is a pull request.
    writeFileSync(join(dir, "event.json"), JSON.stringify({ issue: { number: 7, pull_request: { url: "x" } } }))
    process.env.GITHUB_EVENT_PATH = join(dir, "event.json")
    try {
      await Effect.runPromise(Reporter.use((rep) => rep.write(dir, r, [], { startedAt: "", finishedAt: "", durationsMs: {} })).pipe(
        Effect.provide(ReporterLive.pipe(Layer.provide(BunServices.layer))),
      ))
    } finally {
      if (saved.server === undefined) delete process.env.GITHUB_SERVER_URL
      else process.env.GITHUB_SERVER_URL = saved.server
      if (saved.repo === undefined) delete process.env.GITHUB_REPOSITORY
      else process.env.GITHUB_REPOSITORY = saved.repo
      if (saved.event === undefined) delete process.env.GITHUB_EVENT_PATH
      else process.env.GITHUB_EVENT_PATH = saved.event
    }
    const anchor = new Bun.CryptoHasher("sha256").update("src/main/money/Fx.kt").digest("hex")
    expect(readFileSync(join(dir, "gauntlet-report.md"), "utf8")).toContain(`(${REPO}/pull/7/files#diff-${anchor})`)
  })
})
