import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { coverage, parseProjects, runSuite } from "../src/gates.ts"

// Gauntlet's own coverage run on a build with several projects, as
// tweet-street's bank-checks (sbt 2.0.8, sbt-scoverage 2.4.4, 8 projects and
// an aggregating root). One shared coverageDataDir made every project's
// coverageReport read every project's instrumentation and fail ("No source
// root found"), so scoverage wrote no report. Each project gets its own
// folder, and each project's report is read. Output as sbt 2 printed it.

const FILES: Record<string, string> = {
  "build.sbt": "lazy val root = (project in file(\".\")).aggregate(policy, screening)\n",
  "policy/src/main/scala/checks/policy/Rules.scala": "package checks.policy\n\nobject Rules:\n  def allow(n: Int): Boolean =\n    n > 0\n",
  "screening/src/main/scala/checks/screening/Screen.scala": "package checks.screening\n\nobject Screen:\n  def run(n: Int): Int =\n    n + 1\n",
}

const PROJECTS = (dir: string) => [
  "[info] welcome to sbt 2.0.8 (Homebrew Java 26.0.2.1)",
  `[info] loading project definition from ${dir}/project`,
  `[info] In file:/private${dir}/`,
  "[info] \t   access",
  "[info] \t   admin",
  "[info] \t   app",
  "[info] \t   bank-events",
  "[info] \t   monitoring",
  "[info] \t   platform",
  "[info] \t   policy",
  "[info] \t * root",
  "[info] \t   screening",
  "[success] elapsed time: 0 s",
].join("\n")

// scoverage 2.4.4's Cobertura for one project: file names from the project's own source root.
const cobertura = (dir: string, project: string, file: string, hits: Array<[number, number]>) => `<?xml version="1.0"?>
<!DOCTYPE coverage SYSTEM "https://cobertura.sourceforge.net/xml/coverage-04.dtd">
<coverage
line-rate="0.50" lines-valid="2" lines-covered="1" branches-valid="0" branches-covered="0" branch-rate="0.00" complexity="0" version="1.0" timestamp="1791818083267">
    <sources>
        <source>--source</source>
        <source>
            ${dir}/${project}/src/main/scala
        </source>
    </sources>
    <packages>
        <package name="checks.${project}" line-rate="0.50" branch-rate="0.00" complexity="0">
            <classes>
                <class
                name="checks.${project}.X" filename="${file}" line-rate="0.50" branch-rate="0.00" complexity="0">
                    <methods>
                        <method name="checks.${project}/X/run" signature="()V" line-rate="0.50" branch-rate="0.00" complexity="0">
                            <lines>
${hits.map(([n, h]) => `                                <line number="${n}" hits="${h}" branch="false"/>`).join("\n")}
                            </lines>
                        </method>
                    </methods>
                    <lines>
${hits.map(([n, h]) => `                        <line number="${n}" hits="${h}" branch="false"/>`).join("\n")}
                    </lines>
                </class>
            </classes>
        </package>
    </packages>
</coverage>
`

const commandsOf = (r: RunRequest) => r.args[1]!.split("; ").slice(2)

const bankChecks = (projects: (dir: string) => string = PROJECTS) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-scala-projects-"))
  for (const [p, t] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-scala-projects-out-")), "0-coverage")
  mkdirSync(out)
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: { zones: [], arch: [] } as never,
    facts: { addedLines: new Map() } as never,
    files: Object.keys(FILES).sort(),
    legacy: [],
  }
  const calls: string[][] = []
  // sbt as it behaves: a project writes its report only into its own folder; a shared folder writes none.
  const write = (project: string, file: string, hits: Array<[number, number]>) => {
    const target = join(out, "scoverage", project, "coverage-report", "cobertura.xml")
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, cobertura(dir, project, file, hits))
  }
  const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, {
    run: (r) => Effect.sync(() => {
      const commands = commandsOf(r)
      calls.push(commands)
      if (commands[0] === "projects") return { exitCode: 0, stdout: projects(dir), stderr: "" }
      if (commands.some((c) => c.startsWith("set Seq(") && c.includes(`LocalProject("policy") / coverageDataDir`))) {
        write("policy", "checks/policy/Rules.scala", [[4, 1], [5, 1]])
        write("screening", "checks/screening/Screen.scala", [[4, 1], [5, 0]])
        return { exitCode: 0, stdout: "[warn] No coverage data, skipping reports\n", stderr: "" }
      }
      return { exitCode: 1, stdout: "[error] (policy / coverageReport) No source root found for 'screening/src/main/scala/checks/screening/Screen.scala'\n", stderr: "" }
    }),
  }), BunServices.layer)
  const run = <A>(e: Effect.Effect<A, never, unknown>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>)
  return { ctx, dir, out, calls, run }
}

const GATE = { kind: "gate", name: "coverage", ratchet: false, scope: "all" } as never

describe("coverage of an sbt build with several projects", () => {
  test("each project writes into its own folder, and every project's report is read", async () => {
    const b = bankChecks()
    const r = await b.run(coverage(GATE, b.ctx))
    expect(r.error).toBeUndefined()
    const ids = ["access", "admin", "app", "bank-events", "monitoring", "platform", "policy", "root", "screening"]
    expect(b.calls.at(-1)).toEqual([
      `set Seq(${ids.map((id) => `LocalProject(${JSON.stringify(id)}) / coverageDataDir := file(${JSON.stringify(join(b.out, "scoverage", id))})`).join(", ")})`,
      "coverage", "test", "coverageReport",
    ])
    expect(r.metrics?.coverage).toMatchObject({
      value: 75,
      perFile: { "policy/src/main/scala/checks/policy/Rules.scala": 100, "screening/src/main/scala/checks/screening/Screen.scala": 50 },
    })
  })

  test("the suite that measures coverage for the coverage gate sets the same folders", async () => {
    const b = bankChecks()
    await b.run(runSuite({ name: "unit", location: "**" }, { ...b.ctx, withCoverage: true }))
    expect(b.calls.at(-1)!.some((c) => c.startsWith("set Seq(LocalProject(\"access\") / coverageDataDir"))).toBe(true)
    expect(b.calls.at(-1)!.slice(-1)).toEqual(["coverageReport"])
  })

  test("a build with one project keeps one folder for the build", async () => {
    const b = bankChecks((dir) => `[info] In file:${dir}/\n[info] \t * calc\n`)
    await b.run(coverage(GATE, b.ctx))
    expect(b.calls.at(-1)![0]).toBe(`set every coverageDataDir := file(${JSON.stringify(join(b.out, "scoverage"))})`)
  })
})

describe("parseProjects", () => {
  test("reads the checkout's build's projects from sbt's listing", () => {
    expect(parseProjects(PROJECTS("/w/bank-checks"), "/w/bank-checks")).toEqual(["access", "admin", "app", "bank-events", "monitoring", "platform", "policy", "root", "screening"])
  })

  test("of several builds, the checkout's", () => {
    const listing = ["[info] In file:/elsewhere/lib/", "[info] \t   lib", "[info] In file:/w/app/", "[info] \t * app", "[info] \t   core"].join("\n")
    expect(parseProjects(listing, "/w/app")).toEqual(["app", "core"])
  })

  test("no listing, no projects", () => {
    expect(parseProjects("[error] Not a valid command: projects\n", "/w")).toEqual([])
  })
})
