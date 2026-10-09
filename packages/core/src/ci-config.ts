import { Effect, Option } from "effect"
import type { ProcessRunner } from "./process-runner.ts"

// How Gauntlet's GitHub check builds a project the way its own CI does
// (`.gauntlet/ci.yml`). Some projects only build after their own setup (Nix,
// sibling checkouts, artifacts published locally) and with their own command
// (`nix develop .#ci -c ./gradlew -PlarkSource=...`). `gauntlet connect
// github` reads the project's CI workflows and writes this file; the
// workflow runs `setup` before the checks, and `gauntlet check --ci` runs
// each build's tools as `builds` says. Locally nothing changes.

export const CI_CONFIG_PATH = ".gauntlet/ci.yml"

/** One build's way of running its tool in CI. */
export interface CiBuild {
  /** A command every tool process in the build runs under, such as `nix develop .#ci -c`. */
  readonly wrap?: string
  /** The build tool as CI runs it, such as `./gradlew -PlarkSource=$GITHUB_WORKSPACE/deps/lark`. */
  readonly tool?: string
}

export interface CiConfig {
  /** GitHub Actions steps run before Gauntlet's checks. */
  readonly setup: ReadonlyArray<Readonly<Record<string, unknown>>>
  /** By build folder ("." for the root). */
  readonly builds: Readonly<Record<string, CiBuild>>
}

const words = (s: string | undefined) => (s ?? "").trim().split(/\s+/).filter(Boolean)

/** `.gauntlet/ci.yml`, or none when it isn't there or isn't a mapping. */
export const parseCiConfig = (text: string): Option.Option<CiConfig> => {
  let doc: unknown
  try {
    doc = Bun.YAML.parse(text)
  } catch {
    return Option.none()
  }
  if (typeof doc !== "object" || doc === null) return Option.none()
  const o = doc as { setup?: unknown; builds?: unknown }
  const setup = Array.isArray(o.setup) ? o.setup.filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null) : []
  const builds: Record<string, CiBuild> = {}
  for (const [dir, b] of Object.entries(typeof o.builds === "object" && o.builds !== null ? o.builds : {})) {
    if (typeof b !== "object" || b === null) continue
    const { wrap, tool } = b as { wrap?: unknown; tool?: unknown }
    builds[dir] = { ...(typeof wrap === "string" && wrap.trim() !== "" ? { wrap } : {}), ...(typeof tool === "string" && tool.trim() !== "" ? { tool } : {}) }
  }
  return Option.some({ setup, builds })
}

/** A build's CI settings: its own, or those of the nearest folder above it (an included build runs in its parent's job). */
export const ciBuildFor = (config: CiConfig, dir: string): CiBuild | undefined => {
  for (let d = dir; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : ".") {
    if (config.builds[d]) return config.builds[d]
    if (d === ".") return undefined
  }
}

/** $VAR and ${VAR} from the environment, as a shell would. */
const expand = (s: string, env: Readonly<Record<string, string | undefined>>) => s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, v: string) => env[v] ?? "")

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1)

/**
 * A ProcessRunner that runs a build's tools as its CI does: the build tool
 * (matched by name, also when run through `sh`) replaced by the configured
 * command, and everything under the wrapper.
 */
export const wrappedRunner = (runner: ProcessRunner["Service"], build: CiBuild, env: Readonly<Record<string, string | undefined>> = process.env): ProcessRunner["Service"] => {
  const tool = words(build.tool).map((w) => expand(w, env))
  const wrap = words(build.wrap).map((w) => expand(w, env))
  const name = tool[0] ? base(tool[0]) : undefined
  return {
    run: (request) => {
      let argv = [request.command, ...request.args]
      // The tool keeps the path it was run by (an included build uses the wrapper above it) and gains CI's settings.
      if (name !== undefined) {
        if (base(argv[0]!) === name) argv = [argv[0]!, ...tool.slice(1), ...argv.slice(1)]
        else if (argv[0] === "sh" && argv[1] !== undefined && base(argv[1]) === name) argv = ["sh", argv[1], ...tool.slice(1), ...argv.slice(2)]
      }
      if (wrap.length > 0) argv = [...wrap, ...argv]
      return runner.run({ ...request, command: argv[0]!, args: argv.slice(1) })
    },
  }
}

/** Runs an effect with its build's tools run as CI does, when the config says how. */
export const asInCi = <A, E, R>(effect: Effect.Effect<A, E, R>, config: CiConfig | undefined, dir: string, runner: ProcessRunner["Service"], tag: typeof ProcessRunner) => {
  const build = config ? ciBuildFor(config, dir) : undefined
  return build && (build.wrap || build.tool) ? Effect.provideService(effect, tag, wrappedRunner(runner, build)) : effect
}
