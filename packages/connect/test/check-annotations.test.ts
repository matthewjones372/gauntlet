import { afterEach, describe, expect, test } from "bun:test"
import { compilePolicy, formatDiagnostics } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { github } from "../src/index.ts"

// Spec 0011 §3: findings on the change's lines (surviving mutants, new lint
// findings) reach the pull request's diff as the check run's annotations.

const root = join(import.meta.dir, "..", "..", "..")
const text = readFileSync(join(root, "examples/fixtures/kotlin-service/.gauntlet/policy.gx"), "utf8")
const compiled = compilePolicy({ file: ".gauntlet/policy.gx", text }, [jvmSpec])
if (compiled._tag === "Invalid") throw new Error(formatDiagnostics(compiled.diagnostics, text))

type Step = { name: string; run?: string }
const workflow = Bun.YAML.parse(github({
  mode: "repo",
  ir: compiled.compiled.ir,
  files: ["settings.gradle.kts"],
  gauntletVersion: "0.1.0",
  downloadUrl: "https://example.invalid/gauntlet-linux-x64",
  sha256: "a".repeat(64),
})[0]!.content) as { jobs: Record<string, { steps: Step[] }> }
const post = workflow.jobs.status!.steps.find((s) => s.name === "Post the report and the check")!.run!

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const annotation = { path: "src/A.kt", start_line: 3, end_line: 3, annotation_level: "warning", title: "mutation: mutation/survived", message: "No test kills a conditional-boundary mutant" }

/**
 * Runs the step with a `gh` that keeps each check run it's sent. With
 * `refuseAnnotations`, it refuses a check run that has any, as GitHub does
 * when it can't place one.
 */
const runPost = (status: object, refuseAnnotations = false) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-wf-"))
  dirs.push(dir)
  mkdirSync(join(dir, "gauntlet-out"))
  writeFileSync(join(dir, "gauntlet-out", "status.json"), JSON.stringify(status))
  writeFileSync(join(dir, "gauntlet-out", "gauntlet-report.md"), "## Gauntlet: auto\n")
  const sent = join(dir, "sent")
  const refuse = refuseAnnotations ? `jq -e '.output.annotations | length > 0' "${sent}.last" > /dev/null && exit 1` : ""
  writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$*" in
  *check-runs*) cat > "${sent}.last"; ${refuse}
    jq -c . "${sent}.last" >> "${sent}" ;;
esac
`)
  chmodSync(join(dir, "gh"), 0o755)
  const r = Bun.spawnSync(["bash", "-e", "-c", post], { cwd: dir, env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", PR: "7", HEAD: "h".repeat(40) } })
  const posted = existsSync(sent) ? readFileSync(sent, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : []
  return { code: r.exitCode, posted, stderr: r.stderr.toString() }
}

describe("the check run's annotations", () => {
  const status = { conclusion: "success", title: "Auto: no review needed", summary: "Integrity: no forbidden changes.\nGates: 2 passed.", approvedBy: [], honouredOverrides: [], annotations: [annotation] }

  test("the check run carries the status's annotations with its conclusion, title and summary", () => {
    const r = runPost(status)
    expect(r.code).toBe(0)
    expect(r.posted).toEqual([{
      name: "gauntlet", head_sha: "h".repeat(40), status: "completed", conclusion: "success",
      output: { title: "Auto: no review needed", summary: "Integrity: no forbidden changes.\nGates: 2 passed.", annotations: [annotation] },
    }])
  })

  test("a status from before annotations posts none", () => {
    const { annotations: _, ...older } = status
    expect(runPost(older).posted[0].output.annotations).toEqual([])
  })

  test("when GitHub refuses the annotations, the check is posted without them", () => {
    const r = runPost(status, true)
    expect(r.code).toBe(0)
    expect(r.posted).toHaveLength(1)
    expect(r.posted[0].conclusion).toBe("success")
    expect(r.posted[0].output.annotations).toEqual([])
  })
})
