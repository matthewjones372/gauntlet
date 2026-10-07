import type { GateContext } from "@gauntlet/core"
import { ProcessRunner } from "@gauntlet/core"
import { Effect } from "effect"

// How the Clojure pack runs a project, with the Clojure CLI (deps.edn) or
// Leiningen (project.clj). Gauntlet brings its own runners (kaocha with its
// JUnit plugin, cloverage) at pinned versions, added for the one invocation:
// an alias passed with -Sdeps, or `lein update-in :dependencies conj`. The
// project's own files are never edited.

export interface ToolRun {
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

export interface Library {
  readonly coord: string
  readonly version: string
}

export const KAOCHA: ReadonlyArray<Library> = [
  { coord: "lambdaisland/kaocha", version: "1.91.1392" },
  { coord: "lambdaisland/kaocha-junit-xml", version: "1.17.101" },
]
export const CLOVERAGE: ReadonlyArray<Library> = [{ coord: "cloverage/cloverage", version: "1.2.4" }]

export type BuildTool = "deps" | "lein"

/** deps.edn wins when a project has both. */
export const buildTool = (files: ReadonlyArray<string>): BuildTool | undefined =>
  files.includes("deps.edn") ? "deps" : files.includes("project.clj") ? "lein" : undefined

const IGNORED = /(^|\/)(target|\.cpcache|\.clj-kondo|\.lsp|\.shadow-cljs|node_modules|out)\//

/** Clojure on the JVM: .clj and .cljc. ClojureScript runs elsewhere and isn't judged by this pack. */
export const isClojure = (p: string) => /\.(clj|cljc)$/.test(p) && !IGNORED.test(p) && p !== "project.clj"
export const isTestFile = (p: string) => isClojure(p) && (/^test(-[\w-]+)?\//.test(p) || /(^|\/)test\//.test(p) || /_test\.cljc?$/.test(p))
export const isMainSource = (p: string) => isClojure(p) && !isTestFile(p) && !/^(dev|env|script|scripts|bench|benchmarks)\//.test(p)

/** The top-level directories holding test files: kaocha and cloverage are told about these. */
export const testRoots = (files: ReadonlyArray<string>) => {
  const roots = [...new Set(files.filter(isTestFile).map((p) => p.split("/")[0]!).filter((r) => !r.endsWith(".clj") && !r.endsWith(".cljc")))].sort()
  return roots.length > 0 ? roots : ["test"]
}
export const sourceRoots = (files: ReadonlyArray<string>) => {
  const roots = [...new Set(files.filter(isMainSource).map((p) => p.split("/")[0]!).filter((r) => !r.endsWith(".clj") && !r.endsWith(".cljc")))].sort()
  return roots.length > 0 ? roots : ["src"]
}

/** The namespace a file path implies: src/svc/domain/money_test.clj is svc.domain.money-test. */
export const nsOfPath = (p: string) => p.replace(/^[^/]+\//, "").replace(/\.cljc?$/, "").replaceAll("/", ".").replaceAll("_", "-")

const edn = (s: string) => JSON.stringify(s)

/**
 * The command that runs `main` with `args` on the project's test classpath,
 * plus `libraries`. With deps.edn, the project's `:test` alias is used when it
 * has one; Gauntlet's alias comes last, so its main wins.
 */
export const command = (ctx: GateContext, tool: BuildTool, hasTestAlias: boolean, libraries: ReadonlyArray<Library>, main: string, args: ReadonlyArray<string>): string[] => {
  if (tool === "deps") {
    const deps = libraries.map((l) => `${l.coord} {:mvn/version ${edn(l.version)}}`).join(" ")
    // clojure.main takes its options (-e) directly; any other main is run with -m and gets the arguments.
    const mainOpts = main === "clojure.main" ? args : ["-m", main]
    const alias = `{:aliases {:gauntlet {:extra-deps {${deps}} :extra-paths [${testRoots(ctx.files).map(edn).join(" ")}] :main-opts [${mainOpts.map(edn).join(" ")}]}}}`
    return ["clojure", "-Sdeps", alias, `-M${hasTestAlias ? ":test" : ""}:gauntlet`, ...(main === "clojure.main" ? [] : args)]
  }
  return [
    "lein",
    ...libraries.flatMap((l) => ["update-in", ":dependencies", "conj", `[${l.coord} ${edn(l.version)}]`, "--"]),
    "with-profile", "+test", "run", "-m", main, ...args,
  ]
}

export const run = (ctx: GateContext, argv: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const result = yield* Effect.exit(runner.run({ command: argv[0]!, args: argv.slice(1), cwd: ctx.dir, env: { NO_COLOR: "1", LEIN_SILENT: "true" } }))
    if (result._tag === "Failure") return { command: argv, exitCode: -1, stdout: "", stderr: "", error: `${argv[0]} couldn't be started or timed out` } satisfies ToolRun
    return { command: argv, ...result.value } satisfies ToolRun
  })
