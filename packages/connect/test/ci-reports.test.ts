import { describe, expect, test } from "bun:test"
import { keepCiReports } from "../src/index.ts"
import { github } from "../src/index.ts"
import { compiled } from "../../core/test/fixtures.ts"

// ADR 0024: the project's own CI keeps its reports, so Gauntlet reads what it
// already ran instead of running it again.

const WORKFLOW = `name: build
on: pull_request
jobs:
  api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Build and test
        working-directory: api
        run: |
          ./gradlew -Pfast=true \\
            build --stacktrace
      - name: Test reports
        if: failure()
        uses: actions/upload-artifact@v4
        with: { name: reports, path: api/build }
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Build and test
        working-directory: checks
        run: sbt -batch compile test
`
const all = () => ({ gradle: true, sbt: true })

describe("keeping the CI's reports", () => {
  test("each build job keeps its reports after its build step, and measures coverage while its tests run", () => {
    const wired = keepCiReports(WORKFLOW, ["api", "checks"], all)!
    expect(wired.jobs).toEqual(["api", "checks"])
    const doc = Bun.YAML.parse(wired.text) as { jobs: Record<string, { steps: { name?: string; run?: string; with?: { name?: string } }[] }> }
    const api = doc.jobs.api!.steps
    expect(api.map((s) => s.name ?? "")).toEqual(["", "Build and test", "Keep the test and coverage reports for Gauntlet", "Upload the reports for Gauntlet", "Test reports"])
    expect(api[1]!.run).toContain("build --stacktrace koverXmlReport")
    expect(api[3]!.with!.name).toBe("gauntlet-reports-api")
    expect(doc.jobs.checks!.steps[1]!.run).toBe("sbt -batch compile coverage test coverageReport")
  })

  test("coverage only from a build that has its tool, and nothing twice", () => {
    const wired = keepCiReports(WORKFLOW, ["api", "checks"], () => ({ gradle: false, sbt: false }))!
    expect(wired.coverage).toEqual([])
    expect(wired.text).not.toContain("koverXmlReport")
    expect(keepCiReports(wired.text, ["api", "checks"], all)).toBeUndefined()
  })

  test("with the CI keeping reports, the evidence job waits for its run and reads them", () => {
    const ir = compiled(`gauntlet "x"\nuse jvm\nowners @p\ngates { fast { build } }\n`).ir
    const workflow = github({ mode: "repo", ir, files: [], gauntletVersion: "0", downloadUrl: "https://example.invalid/g", reuseCi: true })[0]!.content
    const evidence = (Bun.YAML.parse(workflow) as { jobs: { evidence: { permissions: Record<string, string>; steps: { id?: string; run?: string }[] } } }).jobs.evidence
    expect(evidence.permissions).toEqual({ contents: "read", actions: "read" })
    expect(evidence.steps.find((s) => s.id === "ci")?.run).toContain("gauntlet-reports-")
    expect(evidence.steps.find((s) => s.run?.includes("check --policy-ref"))?.run).toContain("--ci-reports ci-reports")
  })
})
