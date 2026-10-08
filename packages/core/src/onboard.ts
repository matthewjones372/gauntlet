import { Compiler, DEFAULT_POLICY_FILE, globMatches } from "@gauntlet/dsl"
import { Effect, FileSystem, Option, Path } from "effect"
import { Git } from "./git.ts"
import { inferArch, inferZones } from "./infer.ts"
import { PackRegistry } from "./pack-registry.ts"

// `gauntlet init --template`: a first policy from the packs' defaults, with no
// model involved. Each pack looks at the repository and proposes what it can
// gate with the tools the project already has; the core merges the proposals
// into policy text. Gates whose tool isn't set up are left out (a gate without
// its tool fails as missing evidence) and come back as setup hints instead.

/** What the onboarding step can see of the repository. */
export interface RepoView {
  readonly files: ReadonlyArray<string>
  /** A file's text, or undefined when it doesn't exist or can't be read. */
  readonly read: (path: string) => string | undefined
}

/** One pack's proposal for a repository. */
export interface Onboarding {
  readonly protect: {
    readonly tests: ReadonlyArray<string>
    readonly fixtures: ReadonlyArray<string>
    readonly config: ReadonlyArray<string>
  }
  readonly suites: ReadonlyArray<{ readonly name: string; readonly location: string }>
  /** Gate entries for the fast tier, as policy text (`build`, `lint ratchet`). */
  readonly fast: ReadonlyArray<string>
  /** Gate entries for the verify tier after the suites (`coverage ratchet on changed`). */
  readonly verify: ReadonlyArray<string>
  /** What to set up to add the gates that were left out. */
  readonly setup: ReadonlyArray<string>
  /**
   * Commands that install the missing tools as project dependencies, for
   * `gauntlet setup` to offer (each an argv, run in the repository root).
   * Only for tools a single command sets up; the rest stay hints.
   */
  readonly install?: ReadonlyArray<ReadonlyArray<string>>
}

export interface DraftRequest {
  readonly name: string
  readonly owners: ReadonlyArray<string>
  /**
   * Strict: zones and arch rules inferred from the layout, and floors for new
   * code on top of the ratchets (`gauntlet init`'s default). Otherwise
   * lenient: ratchets only, with zones and arch as commented examples.
   */
  readonly strict?: boolean
  /** Rule names the used packs offer (`go.no-floating-money`), for inferred zones. */
  readonly packRules?: ReadonlyArray<string>
  /** Whether a used pack implements the `arch` gate. */
  readonly archGate?: boolean
  /** Proposals by pack name, in the order the packs are listed. */
  readonly proposals: ReadonlyArray<{ readonly pack: string; readonly onboarding: Onboarding }>
}

export interface Draft {
  readonly text: string
  readonly setup: ReadonlyArray<string>
  /** The packs' install commands, when any tool can be installed for the person. */
  readonly install?: ReadonlyArray<ReadonlyArray<string>>
}

const quote = (s: string) => JSON.stringify(s)
const unique = <A>(xs: ReadonlyArray<A>): A[] => [...new Set(xs)]
/** Two packs both gating `build` (or a suite named `unit`) give one entry. */
const byName = (entries: ReadonlyArray<string>) => {
  const seen = new Set<string>()
  return entries.filter((e) => {
    const name = e.split(" ")[0]!
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
}

const GITHUB_WORKFLOWS = ".github/workflows/**"

/** Floors for new and changed code, added to a ratchet that has none. */
const FLOORS: Readonly<Record<string, string>> = { coverage: ">= 80%", mutation: ">= 60%" }
const FLOOR = />=\s*\d/
const withFloor = (gate: string) => {
  const [name, ...rest] = gate.split(" ")
  const floor = FLOORS[name!]
  if (!floor || FLOOR.test(gate) || rest[0] !== "ratchet") return gate
  return [name, "ratchet", floor, ...rest.slice(1)].join(" ")
}

export const draftPolicy = (r: DraftRequest, files: ReadonlyArray<string>): Draft => {
  const all = r.proposals.map((p) => p.onboarding)
  const workflows = files.some((f) => f.startsWith(".github/workflows/")) ? [GITHUB_WORKFLOWS] : []
  const groups = [
    ["tests", unique(all.flatMap((o) => o.protect.tests))],
    ["fixtures", unique(all.flatMap((o) => o.protect.fixtures))],
    ["config", unique([...all.flatMap((o) => o.protect.config), ...workflows])],
  ] as const
  const present = groups.filter(([, globs]) => globs.length > 0)
  const width = Math.max(...present.map(([g]) => g.length))
  const suiteNames = new Set<string>()
  const suites = all.flatMap((o) => o.suites).filter((s) => !suiteNames.has(s.name) && suiteNames.add(s.name))
  const suiteWidth = Math.max(0, ...suites.map((s) => s.name.length))
  const protectedGlobs = present.flatMap(([, globs]) => globs)
  const zones = r.strict ? inferZones(files, protectedGlobs, r.packRules ?? [], r.owners.length > 0) : []
  const arch = r.strict && r.archGate ? inferArch(files, protectedGlobs) : undefined
  const fast = byName([...all.flatMap((o) => o.fast), ...(arch ? ["arch"] : [])])
  const verify = byName([...suites.map((s) => s.name), ...all.flatMap((o) => o.verify)]).map((g) => (r.strict ? withFloor(g) : g))
  const floors = verify.some((g) => FLOOR.test(g))
  const tiers = [["fast", fast], ["verify", verify]] as const
  const tierWidth = Math.max(...tiers.filter(([, g]) => g.length > 0).map(([t]) => t.length), 0)

  const lines: string[] = [
    r.strict
      ? `// Drafted by \`gauntlet init\` from the ${r.proposals.map((p) => p.pack).join(" and ")} pack defaults and this repository's layout.`
      : `// Drafted by \`gauntlet init --template\` from the ${r.proposals.map((p) => p.pack).join(" and ")} pack defaults.`,
    "// Read every block before committing it: this file decides what agents' changes must pass.",
    `gauntlet ${quote(r.name)}`,
    `use ${r.proposals.map((p) => p.pack).join(", ")}`,
    "mode shadow // report only, never block. Switch to enforce once `gauntlet report shadow` looks right.",
    r.owners.length > 0 ? `owners ${r.owners.join(", ")}` : "// owners @your-team // who approves owner-tier changes and edits to this policy",
    "",
  ]
  if (present.length > 0) {
    lines.push("protect {")
    for (const [group, globs] of present) lines.push(`  ${group.padEnd(width)} ${globs.map(quote).join(", ")}`)
    lines.push("}", "")
  }
  if (zones.length > 0) {
    lines.push("// Zones mark code that needs its owners' review, and scope stricter rules to it.")
    for (const z of zones) {
      lines.push(`// Inferred from folder names: ${z.why}.`, `zone ${z.name} {`, `  paths ${z.globs.map(quote).join(", ")}`)
      lines.push(r.owners.length > 0 ? `  owner ${r.owners.join(", ")}` : "  // owner @your-team")
      if (z.rules.length > 0) lines.push(`  rule ${z.rules.join(", ")}`)
      lines.push("}", "")
    }
  } else {
    lines.push(
      "// Zones mark code that needs its owners' review, and scope stricter rules to it:",
      "// zone money {",
      "//   paths \"src/**/payments/**\"",
      "//   owner @payments",
      "// }",
      "",
    )
  }
  if (arch) {
    lines.push(`// Inferred from folder names: ${arch.inner} is the inner layer, so it never imports the outer ones.`, `arch { module ${arch.inner} must not depend on ${arch.outer.join(", ")} }`, "")
  } else {
    lines.push("// Lower layers never import higher ones:", "// arch { module domain must not depend on infra }", "")
  }
  if (suites.length > 0) {
    lines.push("suites {")
    for (const s of suites) lines.push(`  ${s.name.padEnd(suiteWidth)} ${quote(s.location)}`)
    lines.push("}", "")
  }
  if (fast.length + verify.length > 0) {
    if (floors) lines.push(`// Ratchets keep each file from getting worse; the floors apply to new and changed lines only, so old code doesn't block a change.`)
    lines.push("gates {")
    for (const [tier, gates] of tiers) if (gates.length > 0) lines.push(`  ${tier.padEnd(tierWidth)} { ${gates.join(", ")} }`)
    lines.push("}", "")
  }
  lines.push(
    "predicate small = diff < 150 lines and no zone touched",
    "",
    "review {",
    "  owner  when zone touched",
    ...(present.length > 0 ? ["  review when protected changed"] : []),
    "  review when dependency added",
    ...(fast.length + verify.length > 0 ? ["  auto   when small and all gates pass"] : []),
    "}",
  )
  const install = all.flatMap((o) => o.install ?? []).filter((c, i, cs) => cs.findIndex((d) => d.join(" ") === c.join(" ")) === i)
  return { text: `${lines.join("\n")}\n`, setup: unique(all.flatMap((o) => o.setup)), ...(install.length > 0 ? { install } : {}) }
}

/** Test directories that exist, as globs: `test/**`, or `**\/test/**` when they're nested. */
export const directoriesNamed = (files: ReadonlyArray<string>, names: ReadonlyArray<string>): string[] => {
  const out: string[] = []
  for (const name of names) {
    const atRoot = files.some((f) => f.startsWith(`${name}/`))
    const nested = files.some((f) => f.includes(`/${name}/`))
    if (nested) out.push(`**/${name}/**`)
    else if (atRoot) out.push(`${name}/**`)
  }
  return out
}

/** The policy drafted from the packs' defaults (`init --template`), or why there can't be one. */
export const templateDraft = (root: string, name: string, owners: ReadonlyArray<string>, strict = true) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const files = yield* (yield* Git).listWorkingFiles(root).pipe(Effect.option)
    if (Option.isNone(files)) return { _tag: "Refused", reason: `${root} isn't a git repository. Gauntlet judges commits, so run git init first.` } as const
    const { packs } = yield* PackRegistry
    const detected = packs.filter((p) => p.onboard !== undefined && p.detect?.(files.value) === true)
    if (detected.length === 0) {
      return { _tag: "Refused", reason: `No supported project found here. Installed packs: ${packs.map((p) => `${p.spec.name} (${p.spec.description})`).join("; ")}.` } as const
    }
    // The packs read their own manifests and build files to see which tools are set up.
    const wanted = files.value.filter((f) => detected.some((p) => p.manifests.some((g) => globMatches(g, f))))
    const contents = new Map<string, string>()
    for (const f of wanted) {
      const text = yield* fs.readFileString(path.join(root, f)).pipe(Effect.option)
      if (Option.isSome(text)) contents.set(f, text.value)
    }
    const view = { files: files.value, read: (p: string) => contents.get(p) }
    const draft = draftPolicy({
      name,
      owners,
      strict,
      packRules: detected.flatMap((p) => p.spec.rules.map((r) => r.name)),
      archGate: detected.some((p) => p.gates["arch"] !== undefined),
      proposals: detected.map((p) => ({ pack: p.spec.name, onboarding: p.onboard!(view) })),
    }, files.value)
    // A draft that doesn't compile is Gauntlet's bug, never the user's to fix.
    const compiled = yield* Effect.exit((yield* Compiler).compile({ file: DEFAULT_POLICY_FILE, text: draft.text, files: files.value }))
    if (compiled._tag === "Failure") return { _tag: "Refused", reason: `Gauntlet drafted a policy it can't compile; please report this.\n${draft.text}` } as const
    return { _tag: "Draft", text: draft.text, setup: draft.setup, install: draft.install ?? [], packs: detected.map((p) => p.spec.name) } as const
  })
