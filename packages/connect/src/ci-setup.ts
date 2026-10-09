/** One build's way of running its tool in CI (the same shape as core's `CiBuild`). */
export interface CiBuildCommand {
  readonly wrap?: string
  readonly tool?: string
}

/** `.gauntlet/ci.yml` (the same shape as core's `CiConfig`). */
export interface CiSetupConfig {
  readonly setup: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly builds: Readonly<Record<string, CiBuildCommand>>
}

// Drafting `.gauntlet/ci.yml` from a project's own CI workflows, so Gauntlet's
// GitHub check builds the project as its CI does without anyone writing the
// file by hand. For each job that builds one of the policy's builds, the
// steps before that build step are setup (minus checking out the repository
// itself and uploading reports), and the build step says how the build runs
// its tool: a wrapper (`nix develop .#ci -c`) and the tool with its settings
// (`./gradlew -PlarkSource=...`). Relative paths in those settings point from
// the build's folder; they become paths from the workspace, since Gauntlet
// builds in a checkout of its own.

type Step = Readonly<Record<string, unknown>>

const TOOLS = /(^|\s)(\.\/gradlew|gradle|sbt|mvn|\.\/mvnw)(?=\s|$)/
/** Steps named for tests or reports aren't setup: Gauntlet runs the tests itself. */
const NOT_SETUP = /\b(tests?|reports?|lint|check)\b/i

const runOf = (s: Step) => (typeof s.run === "string" ? s.run.replace(/\\\n\s*/g, " ") : "")
const isRepoCheckout = (s: Step) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout") && !(typeof s.with === "object" && s.with !== null && "repository" in s.with)
const isUpload = (s: Step) => typeof s.uses === "string" && /actions\/upload-artifact/.test(s.uses)
const workingDir = (s: Step) => (typeof s["working-directory"] === "string" ? (s["working-directory"] as string).replace(/^\.\//, "").replace(/\/$/, "") : ".")

/** A path from `dir` as a path from the workspace, for use in Gauntlet's own checkout. */
const fromWorkspace = (dir: string, rel: string) => {
  const parts = dir === "." ? [] : dir.split("/")
  for (const p of rel.split("/")) {
    if (p === "..") parts.pop()
    else if (p !== ".") parts.push(p)
  }
  return `$GITHUB_WORKSPACE/${parts.join("/")}`
}

/** How a build step runs its tool: the words before it, and its own -P/-D settings with paths from the workspace. */
export const buildCommand = (run: string, dir: string): CiBuildCommand | undefined => {
  const line = run.split("\n").find((l) => TOOLS.test(l))
  if (!line) return undefined
  const m = TOOLS.exec(line)!
  const wrap = line.slice(0, m.index + m[1]!.length).trim()
  const tool = m[2]!
  const settings = line.slice(m.index + m[0].length).trim().split(/\s+/).filter((w) => /^-[PD]/.test(w)).map((w) =>
    w.replace(/=(\.\.?\/[^\s]*)$/, (_, rel: string) => `=${fromWorkspace(dir, rel)}`)
  )
  const toolLine = [tool, ...settings].join(" ")
  return { ...(wrap !== "" ? { wrap } : {}), ...(settings.length > 0 ? { tool: toolLine } : {}) }
}

/**
 * `.gauntlet/ci.yml` drafted from the project's workflows, or undefined when
 * none of their jobs builds one of the builds.
 */
export const draftCiConfig = (workflows: ReadonlyArray<{ readonly path: string; readonly text: string }>, buildDirs: ReadonlyArray<string>): CiSetupConfig | undefined => {
  const setup: Step[] = []
  const seen = new Set<string>()
  const builds: Record<string, CiBuildCommand> = {}
  for (const w of workflows) {
    let doc: unknown
    try {
      doc = Bun.YAML.parse(w.text)
    } catch {
      continue
    }
    const jobs = (doc as { jobs?: Record<string, { steps?: Step[] }> } | null)?.jobs ?? {}
    for (const job of Object.values(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : []
      // The job's build step: the last one that runs a build tool in one of the builds' folders.
      const at = steps.map((s, i) => ({ s, i })).filter(({ s }) => TOOLS.test(runOf(s)) && buildDirs.includes(workingDir(s))).at(-1)
      if (!at) continue
      const dir = workingDir(at.s)
      const how = buildCommand(runOf(at.s), dir)
      if (how && !builds[dir]) builds[dir] = how
      for (const s of steps.slice(0, at.i)) {
        if (isRepoCheckout(s) || isUpload(s) || (typeof s.name === "string" && NOT_SETUP.test(s.name) && !/publish/i.test(s.name))) continue
        const key = JSON.stringify(s)
        if (seen.has(key)) continue
        seen.add(key)
        setup.push(s)
      }
    }
  }
  return Object.keys(builds).length > 0 ? { setup, builds } : undefined
}

/** The file's text: a comment saying what it is, then the setup and builds. */
export const renderCiConfig = (c: CiSetupConfig): string =>
  [
    "# How Gauntlet's GitHub check builds this project, drafted from its own CI workflows by",
    "# `gauntlet connect github`. `setup` runs before the checks; `builds` says how each build",
    "# runs its tool there. Locally Gauntlet builds as usual. It's protected: an owner changes it,",
    "# then runs `gauntlet connect github` again.",
    Bun.YAML.stringify({ setup: c.setup, builds: c.builds }, null, 2).trimEnd(),
    "",
  ].join("\n")
