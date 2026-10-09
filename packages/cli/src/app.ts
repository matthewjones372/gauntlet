import {
  agentSummary, BASELINE_PATH, type CheckRecord, BLOCKED_ACK, CheckFailed, checkWorkingTree, endAdoption, nothingToJudge, openAdoption, readAdoption, recordAdoptionEdit, renderAdoptionReport, startAdoption, coverage, templateDraft, explainPolicy, Git, githubStatus, judgeWithEvidence, Overrides, PackRegistry, PolicySource, protectionFor,
  ProcessRunner, protectOnlyIr, pushTarget, recordBaseline, recordBlocked, renderCorpus, runCorpus, renderAgentSummary, renderCoverage, renderDoctor, runDoctor, renderJson, renderMarkdown, APPROVE_BOX, buildsOf, changeLeavesBehaviour, CI_CONFIG_PATH, type CiConfig, parseCiConfig, PrComment, Report, Review, runnerConfigFor, Teams,
  renderFlaky, renderSelftest, renderSelftestText, renderShadowSummary, runCheck, runSelftest, ShadowLog, summariseFlaky, summariseShadow,
} from "@gauntlet/core"
import { type Baseline, decodeBaseline, emptyBaseline, encodeBaseline, parseDetektBaseline, updateBaseline } from "@gauntlet/sarif"
import { claudeCode, codeowners, draftCiConfig, FIX_COMMAND, type GeneratedFile, github, PROPOSAL_FILE, render, renderCiConfig, requireCheckRuleset } from "@gauntlet/connect"
import { defaultPackage, invalidVars, render as renderTemplate, TEMPLATES } from "@gauntlet/templates"
import { type AuthorConfig, authorConfig, authorContext, draftProposals, explainInPlainLanguage, isolationProblem, runSession } from "@gauntlet/author"
import { Compiler, DEFAULT_POLICY_FILE, type Diagnostic, formatDiagnostics, PolicyInvalid } from "@gauntlet/dsl"
import { type PolicyIR, prettyCanonicalJson } from "@gauntlet/ir"
import { BunStdio } from "@effect/platform-bun"
import { GauntletTools, mcpServer } from "@gauntlet/mcp"
import { Clock, Data, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { agentFromEnv } from "./agent.ts"
import { describeChanges } from "./apply.ts"
import { exportCorpus } from "./corpus-export.ts"
import { AuthorRuntime, type AuthorRuntimeShape, renderDropped } from "./author.ts"
import { Ask, ExitStatus, exitWith, LaunchAgent, Output, Stdin, style, withGateProgress } from "./output.ts"
import { GAUNTLET_VERSION } from "./version.ts"

// The CLI. Handlers stay thin: parse flags, call a core program, print, set
// the exit code. Failures Gauntlet can't recover from print a message and
// exit 2; they are never reported as a pass.

const repoFlag = Flag.String("repo").pipe(Flag.withDefault("."), Flag.withDescription("repository root (default: current directory)"))
const jsonFlag = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("print JSON instead of text"))
const policyRefFlag = Flag.optional(Flag.String("policy-ref").pipe(Flag.withDescription("CI: load policy, baseline and protected files from this ref (the PR base)")))
const baseFlag = Flag.optional(Flag.String("base").pipe(Flag.withDescription("local: compare with this ref instead of the default branch")))

const absolute = (dir: string) => Path.Path.use((path) => Effect.succeed(path.resolve(dir)))

const sourceOptions = (policyRef: Option.Option<string>, base: Option.Option<string>) => ({
  ...(Option.isSome(policyRef) ? { policyRef: policyRef.value } : {}),
  ...(Option.isSome(base) ? { baseRef: base.value } : {}),
})

/** Prints a failure Gauntlet can't recover from and sets exit code 2. */
const fail = (message: string) => Effect.gen(function*() {
  yield* (yield* Output).err(message)
  yield* exitWith(2)
})

const describeFailure = (e: unknown): string => {
  if (e instanceof PolicyInvalid) return formatDiagnostics(e.diagnostics, e.text)
  const tagged = e as { readonly _tag?: string; readonly message?: string; readonly ref?: string; readonly stderr?: string; readonly reason?: string }
  switch (tagged._tag) {
    case "CheckFailed": return (e as CheckFailed).message
    case "StepFailed": return tagged.message ?? ""
    case "PolicyNotFound": return `No policy found. Create ${DEFAULT_POLICY_FILE}, or run \`gauntlet init\`.`
    case "BaseRefNotFound": return `The ref '${tagged.ref}' doesn't exist in this repository. Fetch it first, for example: git fetch origin ${tagged.ref}`
    case "GitError": return `git failed: ${tagged.stderr ?? ""}`
    case "BaselineInvalid": return `.gauntlet/baseline.sarif is invalid: ${tagged.reason ?? ""}`
    case "OverrideInvalid": return `Override not recorded: ${tagged.reason ?? ""}`
    default: return `Gauntlet couldn't finish: ${tagged.message ?? String(e)}`
  }
}

// ---------- validate ----------

const validate = Command.make("validate", {
  file: Argument.optional(Argument.String("file").pipe(Argument.withDescription(`policy file (default: ${DEFAULT_POLICY_FILE})`))),
  repo: repoFlag,
  json: jsonFlag,
}, ({ file, repo, json }) =>
  Effect.gen(function*() {
    const out = yield* Output
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* absolute(repo)
    const relative = Option.getOrElse(file, () => DEFAULT_POLICY_FILE)
    const text = yield* fs.readFileString(path.resolve(root, relative)).pipe(Effect.option)
    if (Option.isNone(text)) return yield* fail(`Can't read ${relative}.`)
    const files = yield* (yield* Git).listWorkingFiles(root).pipe(Effect.option)
    const result = yield* Effect.exit((yield* Compiler).compile({ file: relative, text: text.value, ...(Option.isSome(files) ? { files: files.value } : {}) }))
    const diagnostics: ReadonlyArray<Diagnostic> = result._tag === "Success"
      ? result.value.diagnostics
      : result.cause.reasons.flatMap((r) => (r._tag === "Fail" && r.error instanceof PolicyInvalid ? r.error.diagnostics : []))
    if (json) {
      yield* out.out(JSON.stringify({ valid: result._tag === "Success", ...(result._tag === "Success" ? { irHash: result.value.hash } : {}), diagnostics }, null, 2))
    } else {
      if (diagnostics.length > 0) yield* out.out(formatDiagnostics(diagnostics, text.value))
      yield* out.out(result._tag === "Success" ? `${relative} is valid (IR ${result.value.hash.slice(0, 12)}).` : `${relative} is invalid.`)
    }
    if (result._tag === "Failure") yield* exitWith(1)
  })).pipe(Command.withDescription("Check a policy file and explain any problems."))

// ---------- check ----------

const check = Command.make("check", {
  repo: repoFlag,
  policyRef: policyRefFlag,
  base: baseFlag,
  head: Flag.String("head").pipe(Flag.withDefault("HEAD"), Flag.withDescription("commit to judge (default: HEAD; uncommitted changes aren't checked)")),
  out: Flag.optional(Flag.String("out").pipe(Flag.withDescription("directory for the report files (default: .git/gauntlet/report)"))),
  json: jsonFlag,
  noRecord: Flag.Boolean("no-record").pipe(Flag.withDefault(false), Flag.withDescription("don't append a shadow record (git note) for this check")),
  workingTree: Flag.Boolean("working-tree").pipe(Flag.withDefault(false), Flag.withDescription("judge the working tree, uncommitted and new files included, instead of a commit (never recorded)")),
  protectOnly: Flag.Boolean("protect-only").pipe(Flag.withDefault(false), Flag.withDescription("check only the verification boundary: the base commit's policy, protected files restored, gates run fresh; no zones, review levels, mutation or ratchets; pass or fail")),
  holdouts: Flag.Boolean("holdouts").pipe(Flag.withDefault(false), Flag.withDescription("also run holdouts that name their files, from the base commit (for the CI evidence job; elsewhere they show as pending)")),
  ci: Flag.Boolean("ci").pipe(Flag.withDefault(false), Flag.withDescription("run each build's tools as .gauntlet/ci.yml at the base says (Gauntlet's GitHub check)")),
  ciReports: Flag.optional(Flag.String("ci-reports").pipe(Flag.withDescription("the project's own CI reports for this commit, one folder per artifact holding paths from the repository's root: tests, coverage and the build are read from them instead of run again"))),
  ciSource: Flag.optional(Flag.String("ci-source").pipe(Flag.withDescription("where --ci-reports came from (a CI run's URL), for the proof"))),
}, ({ repo, policyRef, base, head, out, json, noRecord, workingTree, protectOnly, holdouts, ci, ciReports, ciSource }) =>
  Effect.gen(function*() {
    const output = yield* Output
    const root = yield* absolute(repo)
    const outDir = Option.isSome(out) ? yield* absolute(out.value) : `${yield* (yield* Git).gitDir(root)}/gauntlet/report`
    if (workingTree && protectOnly) return yield* fail("--working-tree and --protect-only can't be combined: protect-only judges a commit against its base.")
    if (workingTree && holdouts) return yield* fail("--working-tree and --holdouts can't be combined: holdouts run only against a commit, in CI.")
    if (workingTree) {
      const r = yield* checkWorkingTree({ repo: root, outDir, gauntletVersion: GAUNTLET_VERSION, agent: agentFromEnv(process.env) })
      yield* output.out(json ? renderJson(r.report) : renderMarkdown(r.report))
      yield* output.err(`Report written to ${outDir}`)
      return yield* exitWith(r.exitCode)
    }
    const result = yield* runCheck({
      repo: root,
      ...sourceOptions(policyRef, base),
      head,
      outDir,
      gauntletVersion: GAUNTLET_VERSION,
      agent: agentFromEnv(process.env),
      record: !noRecord,
      ...(protectOnly ? { protectOnly: true } : {}),
      ...(holdouts ? { holdouts: true } : {}),
      ...(ci ? { ci: true } : {}),
      ...(Option.isSome(ciReports) ? { ciReports: { files: yield* readCiReports(ciReports.value), source: Option.getOrElse(ciSource, () => ciReports.value) } } : {}),
    })
    yield* output.out(json ? renderJson(result.report) : renderMarkdown(result.report))
    yield* output.err(`Report written to ${outDir}`)
    yield* exitWith(result.exitCode)
  }).pipe(withGateProgress, Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Run the policy's gates and integrity checks and decide the review tier."))

// ---------- explain ----------

const explain = Command.make("explain", {
  block: Argument.optional(Argument.String("block").pipe(Argument.withDescription("mode, protect, zones, gates, integrity or review"))),
  repo: repoFlag,
  policyRef: policyRefFlag,
  base: baseFlag,
  ir: Flag.Boolean("ir").pipe(Flag.withDefault(false), Flag.withDescription("print the canonical Policy IR")),
  coverage: Flag.Boolean("coverage").pipe(Flag.withDefault(false), Flag.withDescription("map every file to what covers it, and list files nothing covers")),
  json: jsonFlag,
}, (args) =>
  Effect.gen(function*() {
    const output = yield* Output
    const root = yield* absolute(args.repo)
    const loaded = yield* (yield* PolicySource).load({ repo: root, ...sourceOptions(args.policyRef, args.base) })
    const { ir, hash } = loaded.compiled
    if (args.ir) return yield* output.out(prettyCanonicalJson({ irHash: hash, ir }))
    if (args.coverage) {
      const map = coverage(ir, yield* (yield* Git).listWorkingFiles(root))
      return yield* output.out(args.json ? prettyCanonicalJson(map) : renderCoverage(map))
    }
    const text = explainPolicy(ir, Option.getOrUndefined(args.block))
    yield* output.out(text)
    if (text.startsWith("Unknown block")) yield* exitWith(2)
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Explain what the policy enforces."))

// ---------- override ----------

const override = Command.make("override", {
  reason: Flag.String("reason").pipe(Flag.withDescription("why this change should merge despite failing")),
  approver: Flag.String("approver").pipe(Flag.withDescription("the owner who must approve, as @user or @org/team")),
  head: Flag.String("head").pipe(Flag.withDefault("HEAD")),
  repo: repoFlag,
  policyRef: policyRefFlag,
  base: baseFlag,
}, (args) =>
  Effect.gen(function*() {
    const output = yield* Output
    const git = yield* Git
    const root = yield* absolute(args.repo)
    const headSha = yield* git.revParse(root, args.head)
    const loaded = yield* (yield* PolicySource).load({ repo: root, ...sourceOptions(args.policyRef, args.base) })
    const requestedBy = process.env.GAUNTLET_REQUESTED_BY ?? Option.getOrElse(yield* git.config(root, "user.email"), () => "unknown")
    yield* (yield* Overrides).record(root, { headSha, irHash: loaded.compiled.hash, reason: args.reason, approver: args.approver, requestedBy })
    yield* output.out(
      `Override recorded for ${headSha.slice(0, 12)} (approver ${args.approver}). It doesn't change the tier. On GitHub it takes effect only after ${args.approver} approves this exact commit; push the note with: git push origin refs/notes/gauntlet-overrides`,
    )
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Record an override for the current commit. It needs a named owner's approval to take effect."))

// ---------- baseline ----------

const TRUNK_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"]

interface BaselineArgs {
  readonly repo: string
  readonly update: boolean
  readonly allowLower: boolean
  readonly importDetekt: Option.Option<string>
  readonly trunk: Option.Option<string>
  /** Whether to tell the person to commit it (`apply` commits it itself). */
  readonly commitHint?: boolean
  /** The policy gained gates since the baseline: grandfather their existing findings (apply). */
  readonly adoptNewGates?: boolean
  /** Setup's baseline: don't mutate the whole project for a mutation check on changed lines. */
  readonly skipChangedMutation?: boolean
}

/** Records (or raises) the baseline on trunk; `gauntlet baseline` and `gauntlet apply` both run it. */
const runBaseline = (args: BaselineArgs) =>
  Effect.gen(function*() {
    const output = yield* Output
    const git = yield* Git
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* absolute(args.repo)
    const head = yield* git.revParse(root, "HEAD")

    // A baseline records trunk, never a feature branch.
    const candidates = Option.isSome(args.trunk) ? [args.trunk.value] : TRUNK_CANDIDATES
    let trunk: Option.Option<{ ref: string; sha: string }> = Option.none()
    for (const ref of candidates) {
      const sha = yield* git.resolve(root, ref)
      if (Option.isSome(sha)) {
        trunk = Option.some({ ref, sha: sha.value })
        break
      }
    }
    if (Option.isNone(trunk)) return yield* fail(`No trunk ref found (tried ${candidates.join(", ")}). Pass --trunk <ref>.`)
    if (trunk.value.sha !== head) {
      // The trunk's own local branch, ahead of the remote with commits not yet pushed
      // (the policy just committed), is still trunk; a feature branch never is.
      const local = trunk.value.ref.startsWith("origin/")
        ? (trunk.value.ref === "origin/HEAD" ? ["main", "master"] : [trunk.value.ref.slice("origin/".length)])
        : []
      const onLocalTrunk = yield* Effect.gen(function*() {
        for (const branch of local) {
          const sha = yield* git.resolve(root, `refs/heads/${branch}`)
          if (Option.isSome(sha) && sha.value === head) return (yield* git.mergeBase(root, trunk.value.sha, head)) === trunk.value.sha
        }
        return false
      })
      if (!onLocalTrunk) {
        return yield* fail(`A baseline records trunk. HEAD (${head.slice(0, 12)}) isn't ${trunk.value.ref} (${trunk.value.sha.slice(0, 12)}); check out ${trunk.value.ref} first.`)
      }
    }

    const loaded = yield* (yield* PolicySource).load({ repo: root, baseRef: head })
    const file = path.join(root, BASELINE_PATH)
    const existingText = yield* fs.readFileString(file).pipe(Effect.option)
    const existing: Option.Option<Baseline> = Option.isSome(existingText) ? Option.some(yield* decodeBaseline(existingText.value)) : Option.none()
    if (Option.isSome(existing) && !args.update && Option.isNone(args.importDetekt)) {
      return yield* fail(`${BASELINE_PATH} already exists. Pass --update to raise it with what trunk records now.`)
    }

    const legacy = Option.isSome(args.importDetekt)
      ? yield* parseDetektBaseline(yield* fs.readFileString(path.resolve(root, args.importDetekt.value)))
      : []
    if (legacy.length > 0 && Option.isSome(existing) && !args.allowLower) {
      yield* output.err(`Importing ${legacy.length} detekt findings would grandfather them into an existing baseline, which lowers the bar. Pass --allow-lower to do it anyway.`)
      return yield* exitWith(1)
    }

    yield* output.err(`Recording a baseline at ${head.slice(0, 12)}; this runs every gate over the whole project.`)
    const recorded = yield* recordBaseline(root, head, loaded.compiled.ir, args.skipChangedMutation ? { skipChangedMutation: true } : {})
    const meta = { commit: head, irHash: loaded.compiled.hash, gauntletVersion: GAUNTLET_VERSION }
    let next: Baseline
    if (Option.isNone(existing)) {
      next = { ...emptyBaseline(meta.commit, meta.irHash, meta.gauntletVersion), metrics: recorded.metrics, results: recorded.results, testIds: recorded.testIds, legacy }
    } else {
      const outcome = updateBaseline(existing.value, { ...meta, metrics: recorded.metrics, results: recorded.results, testIds: recorded.testIds, allowLower: args.allowLower, ...(args.adoptNewGates ? { adoptNewTools: true } : {}) })
      if (outcome.lowers) {
        const lines = [
          ...outcome.loweredMetrics.map((m) => `- ${m.metric}${m.file ? ` (${m.file})` : ""}: ${m.base} -> ${m.head}`),
          ...outcome.newlyGrandfathered.map((r) => `- new finding ${r.ruleId}: ${r.message.text}`),
        ]
        if (!args.allowLower) {
          yield* output.err(["The baseline was not updated, because it would get worse:", ...lines, "", ...lowerActions(outcome.loweredMetrics.map((m) => m.metric), outcome.newlyGrandfathered.length > 0)].join("\n"))
          return yield* exitWith(1)
        }
        yield* output.err(["Lowering the baseline (--allow-lower):", ...lines, "Commit it in its own PR; changing .gauntlet/ needs an owner."].join("\n"))
      }
      next = { ...outcome.baseline, legacy: [...outcome.baseline.legacy, ...legacy] }
    }

    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, encodeBaseline(next))
    const findings = Object.values(next.results).reduce((n, rs) => n + rs.length, 0)
    const missing = recorded.checks.filter((c) => c.status === "not-executed" || c.status === "errored")
    yield* output.out([
      `Wrote ${BASELINE_PATH}: ${Object.keys(next.metrics).length} metrics, ${findings} grandfathered findings, ${next.legacy.length} legacy entries, ${next.testIds.length} test ids.`,
      ...missing.map((c) => `Not recorded: ${c.tier}: ${c.check} (${c.reason ?? c.status})`),
      ...(args.commitHint === false ? [] : [`Commit it. ${BASELINE_PATH} is protected, so the commit needs an owner's review.`]),
    ].join("\n"))
    return { checks: recorded.checks, ir: loaded.compiled.ir }
  })

/**
 * Checks that failed while recording and will fail every change until they're
 * fixed: failing tests, a broken build, a rule over the whole project. Lint
 * findings a ratchet grandfathers and floors on changed lines don't count.
 */
export const persistentFailures = (checks: ReadonlyArray<CheckRecord>, ir: PolicyIR): CheckRecord[] =>
  checks.filter((c) => {
    if (c.status !== "failed" && c.status !== "errored") return false
    for (const tier of ir.gates) {
      for (const g of tier.checks) {
        if (g.kind === "suite" && g.name === c.check) return true
        if (g.kind === "gate" && g.name === c.check) return !(g.ratchet && g.threshold === undefined) && !(g.threshold !== undefined && g.scope === "changed")
      }
    }
    return false
  })

/** Where GitHub looks for CODEOWNERS. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]

/**
 * When the repository has no CODEOWNERS, offer one built from the policy's
 * owners and zones, so GitHub requests the right reviewers. Committed on yes.
 */
const offerCodeowners = (root: string, ir: PolicyIR) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    for (const p of CODEOWNERS_PATHS) if (yield* fs.exists(path.join(root, p))) return
    if (ir.owners.length === 0) {
      return yield* output.out(style.warn(`No CODEOWNERS file, and the policy names no owners. Add ${style.command("owners @your-name")} to .gauntlet/policy.gx (or run /gauntlet-setup), then ${style.command("gauntlet apply")} again to create one.`))
    }
    yield* output.out(style.warn("No CODEOWNERS file, so GitHub won't ask anyone in particular to review."))
    const reply = yield* (yield* Ask).question(style.bold(`Create .github/CODEOWNERS from the policy (${ir.owners.join(", ")}${ir.zones.some((z) => z.owners.length > 0) ? " and the zones' owners" : ""})? [Y/n] `))
    if (Option.isNone(reply)) return yield* output.out(`To add one later: ${style.command("gauntlet connect github")}, or run ${style.command("gauntlet apply")} in a terminal.`)
    if (!/^(|y|yes)$/i.test(reply.value)) return yield* output.out("No CODEOWNERS file written.")
    const file = codeowners(ir)
    yield* fs.makeDirectory(path.join(root, ".github"), { recursive: true })
    yield* fs.writeFileString(path.join(root, file.path), render(file, undefined))
    if (yield* commitIfChanged(root, [file.path], "Add CODEOWNERS from the Gauntlet policy")) yield* output.out(style.ok(`Wrote and committed ${file.path}.`))
  })

/** The last step of setup: Gauntlet's Claude Code hooks, now the policy and baseline are committed. */
const switchOnHooks = (root: string) =>
  Effect.gen(function*() {
    const output = yield* Output
    if (!(yield* connectClaude(root, false))) return
    if (yield* commitIfChanged(root, [".claude/settings.json"], "Switch on Gauntlet's Claude Code hooks")) {
      yield* output.out(style.ok("Switched on Gauntlet's Claude Code hooks: from now on Claude Code checks its work before it finishes."))
    }
  })

/** What a first baseline means, and the order to go in when the project already fails. */
export const firstRunExplained = (mode: "shadow" | "enforce", failing: boolean): string =>
  [
    "",
    style.ok(style.bold("Done. The baseline is today's state of your project.")),
    style.item("Existing lint findings, coverage and mutation scores are recorded, so they don't block a change."),
    style.item("From now on, a change can't make them worse, and new code has to meet the policy's floors."),
    mode === "shadow"
      ? style.item(`Gauntlet is in shadow mode: it reports and blocks nothing. Switch to ${style.command("mode enforce")} in .gauntlet/policy.gx when ${style.command("gauntlet report shadow")} looks right.`)
      : style.item("The policy is in enforce mode: a change that fails is blocked."),
    ...(failing
      ? [
        "",
        style.bold("Failing tests and a broken build aren't grandfathered: they'd fail every change. The way through:"),
        `  1. Fix them (Claude Code can: ${style.command("/gauntlet-fix")}).`,
        `  2. Record the baseline again, so it starts clean: ${style.command("gauntlet baseline --update")}`,
        `  3. Then enforce it: ${style.command("mode enforce")} in .gauntlet/policy.gx.`,
      ]
      : ["", "Claude Code now checks its work with Gauntlet before it finishes."]),
  ].join("\n")

/** The branch setup commits to when it starts on the default branch. */
export const SETUP_BRANCH = "gauntlet/setup"

/**
 * Moves setup onto its own branch when it starts on the default branch, so
 * the default branch gets Gauntlet only through a pull request, where the
 * project's CI runs. Uncommitted work comes along.
 */
const onSetupBranch = (root: string) =>
  Effect.gen(function*() {
    const { current, defaults } = yield* branches(root)
    if (current === "" || !defaults.includes(current)) return
    const runner = yield* ProcessRunner
    const exists = (yield* runner.run({ command: "git", args: ["rev-parse", "--verify", "--quiet", `refs/heads/${SETUP_BRANCH}`], cwd: root }).pipe(Effect.map((r) => r.exitCode === 0), Effect.orElseSucceed(() => false)))
    yield* runGit(root, exists ? ["switch", "-q", SETUP_BRANCH] : ["switch", "-q", "-c", SETUP_BRANCH])
    yield* (yield* Output).out(`Setup commits to the branch ${style.command(SETUP_BRANCH)}, so ${current} gets Gauntlet only through a pull request, where your CI runs.`)
  })

/** On setup's branch, that branch is where the baseline is recorded: it reaches trunk through the pull request. */
const setupTrunk = (root: string) =>
  branches(root).pipe(Effect.map((b) => (b.current === SETUP_BRANCH ? Option.some(SETUP_BRANCH) : Option.none<string>())))

/** How setup's branch reaches the default branch: a pull request. */
const pullRequestHint = (root: string) =>
  Effect.gen(function*() {
    const { current, defaults } = yield* branches(root)
    if (current === "" || defaults.includes(current)) return ""
    return ` Push ${style.command(current)} and open a pull request (${style.command(`git push -u origin ${current}`)}, then ${style.command("gh pr create")}); merge it once its checks pass.`
  })

/** After the first baseline: say what fails, and offer to have Claude Code fix it. */
const offerFix = (root: string, failing: ReadonlyArray<CheckRecord>) =>
  Effect.gen(function*() {
    const output = yield* Output
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* output.out([
      "",
      style.warn("Your project doesn't pass every check yet:"),
      ...failing.map((c) => style.item(`${style.bold(c.check)}: ${c.reason ?? c.status}${c.failures && c.failures.length > 0 ? ` (${c.failures.slice(0, 3).map((f: string) => f.split(":")[0]).join(", ")}${c.failures.length > 3 ? ", ..." : ""})` : ""}`)),
      style.dim("These show on every change until they're fixed. (In shadow mode nothing is blocked.)"),
      "",
    ].join("\n"))
    // Projects set up by an older Gauntlet may not have the command yet.
    const command = path.join(root, ".claude", "commands", "gauntlet-fix.md")
    if (!(yield* fs.exists(command))) {
      yield* fs.makeDirectory(path.dirname(command), { recursive: true })
      yield* fs.writeFileString(command, FIX_COMMAND)
    }
    const later = "When you're ready, open Claude Code here and run /gauntlet-fix. It fixes what it can and reports every change."
    const reply = yield* (yield* Ask).question(style.bold("Want Claude Code to fix them now? It'll report every change it makes. [Y/n] "))
    if (Option.isNone(reply) || !/^(|y|yes)$/i.test(reply.value)) return yield* output.out(later)
    yield* output.out("Opening Claude Code with /gauntlet-fix. Quit it (Ctrl+C twice) to come back here.")
    if (!(yield* (yield* LaunchAgent).claude(root, "/gauntlet-fix"))) {
      yield* output.out(`Claude Code isn't installed here (no \`claude\` on your PATH). ${later}`)
    }
  })

/** What to do when recording the baseline would lower it: fix it on trunk first; accepting it comes last. */
export const lowerActions = (metrics: ReadonlyArray<string>, newFindings: boolean): string[] => {
  const fixes = [
    ...(metrics.some((m) => m === "coverage") ? ["Add tests for the code whose coverage dropped."] : []),
    ...(metrics.some((m) => m !== "coverage") ? [`Restore what made ${[...new Set(metrics.filter((m) => m !== "coverage"))].join(", ")} worse.`] : []),
    ...(newFindings ? ["Fix the new findings."] : []),
  ]
  return [
    "What you can do:",
    ...fixes.map((f, i) => `  ${i + 1}. ${f} Commit it to trunk and run this again.${i === 0 ? " (recommended)" : ""}`),
    `  ${fixes.length + 1}. Accept the lower values: gauntlet baseline --update --allow-lower`,
    "     Not recommended: from then on the ratchet holds changes only to the lower values,",
    "     and the commit changes .gauntlet/, so it needs an owner's review.",
  ]
}

const baseline = Command.make("baseline", {
  repo: repoFlag,
  update: Flag.Boolean("update").pipe(Flag.withDefault(false), Flag.withDescription("raise the existing baseline with what trunk records now")),
  allowLower: Flag.Boolean("allow-lower").pipe(Flag.withDefault(false), Flag.withDescription("accept a lower baseline; the commit changes .gauntlet/ and needs an owner")),
  importDetekt: Flag.optional(Flag.String("import-detekt").pipe(Flag.withDescription("grandfather the findings in a detekt baseline.xml"))),
  trunk: Flag.optional(Flag.String("trunk").pipe(Flag.withDescription("the trunk ref; HEAD must be its tip (default: origin/HEAD, then main or master)"))),
}, (args) => runBaseline(args).pipe(withGateProgress, Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Record or raise the baseline on trunk."))

// ---------- corpus ----------

const corpus = Command.make("corpus", {
  repo: repoFlag,
  dir: Flag.String("dir").pipe(Flag.withDefault("corpus/tamper"), Flag.withDescription("the corpus (default: corpus/tamper)")),
  fixtures: Flag.String("fixtures").pipe(Flag.withDefault("examples/fixtures"), Flag.withDescription("the fixtures the cases patch (default: examples/fixtures)")),
  json: jsonFlag,
  export: Flag.Boolean("export").pipe(Flag.withDefault(false), Flag.withDescription("rewrite the corpus from the fixtures and the packs' tamper generators, instead of running it")),
}, (args) =>
  Effect.gen(function*() {
    const output = yield* Output
    const path = yield* Path.Path
    const root = yield* absolute(args.repo)
    if (args.export) {
      const packs = yield* Effect.promise(() => exportCorpus(root))
      return yield* output.out(`Wrote corpus/tamper for ${packs.join(", ")}. Review the patches, then run gauntlet corpus.`)
    }
    yield* output.err("Running the tamper corpus: each case is a check of a patched fixture, with the gates skipped.")
    const result = yield* runCorpus({
      repo: root,
      corpusDir: path.resolve(root, args.dir),
      fixturesDir: path.resolve(root, args.fixtures),
      outDir: `${yield* (yield* Git).gitDir(root)}/gauntlet/corpus`,
      gauntletVersion: GAUNTLET_VERSION,
    })
    yield* output.out(args.json ? JSON.stringify(result, null, 2) : renderCorpus(result))
    if (!result.passed) yield* exitWith(1)
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Run the public tamper corpus and print the measured detection and false-positive rates per pack."))

// ---------- selftest ----------

const selftest = Command.make("selftest", {
  repo: repoFlag,
  base: Flag.String("base").pipe(Flag.withDefault("HEAD"), Flag.withDescription("the commit fixtures are applied to (default: HEAD)")),
  only: Flag.optional(Flag.String("only").pipe(Flag.withDescription("comma-separated fixture names to run"))),
  json: jsonFlag,
}, ({ repo, base, only, json }) =>
  Effect.gen(function*() {
    const output = yield* Output
    const root = yield* absolute(repo)
    const outDir = `${yield* (yield* Git).gitDir(root)}/gauntlet/selftest`
    const result = yield* runSelftest({
      repo: root,
      base,
      ...(Option.isSome(only) ? { only: only.value.split(",").map((s) => s.trim()).filter((s) => s !== "") } : {}),
      gauntletVersion: GAUNTLET_VERSION,
      outDir,
      progress: (line) => output.err(line),
    })
    // Markdown where it'll be rendered (CI logs, pull request comments); aligned text in a terminal.
    yield* output.out(json ? prettyCanonicalJson(result) : process.stdout.isTTY === true ? renderSelftestText(result) : renderSelftest(result))
    if (!result.passed) yield* exitWith(1)
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Prove the policy catches known tampering: each fixture must be caught."))

// ---------- init and new ----------

const ownersFlag = Flag.optional(Flag.String("owner").pipe(Flag.withDescription("policy owners, comma-separated GitHub users or teams (@alice,@acme/platform)")))
const ownerList = (o: Option.Option<string>) => Option.match(o, { onNone: () => [], onSome: (s) => s.split(",").map((x) => x.trim()).filter((x) => x !== "") })

const NEXT_STEPS = [
  "Next:",
  "  1. Read .gauntlet/policy.gx. Each inferred zone and arch rule has a comment saying why it's there.",
  "  2. gauntlet connect claude-code, then ask Claude to suggest a stricter policy (it can't edit .gauntlet/ itself).",
  "  3. Commit, then record the baseline: gauntlet baseline, and commit .gauntlet/baseline.sarif.",
  "  4. Optionally, gauntlet connect github to check pull requests.",
  "  5. After a few days in shadow mode, gauntlet report shadow; switch to mode enforce when it looks right.",
]

/** Why the authoring agent can't run here (and its configuration when it can). */
const authorSetup = Effect.gen(function*() {
  const runtime = yield* AuthorRuntime
  const isolation = isolationProblem(runtime.env, runtime.interactive)
  if (isolation) return { _tag: "Unavailable", reason: isolation } as const
  const config = authorConfig(runtime.env)
  if (config._tag === "Missing") return { _tag: "Unavailable", reason: config.reason } as const
  return { _tag: "Available", config: config.config, runtime } as const
})

/**
 * The authoring agent proposes, a person accepts block by block, and only the
 * accepted result is written (ADR 0009). Returns the new text, or undefined
 * when nothing was accepted.
 */
const authorFlow = (mode: "init" | "review", root: string, text: string, packNames: ReadonlyArray<string>, config: AuthorConfig, runtime: AuthorRuntimeShape) =>
  Effect.gen(function*() {
    const output = yield* Output
    const ctx = yield* authorContext(root, packNames)
    yield* output.err(`Asking ${config.provider} (${config.model}) for proposals. It only reads; you decide on each one.`)
    const drafted = yield* draftProposals({ mode, text, ctx }).pipe(Effect.provide(runtime.model(config)))
    for (const line of renderDropped(drafted.dropped)) yield* output.err(line)
    if (drafted.proposals.length === 0) {
      yield* output.out("No proposals worth reviewing.")
      return undefined
    }
    const baseIr = yield* (yield* Compiler).compile({ file: DEFAULT_POLICY_FILE, text, files: ctx.files }).pipe(Effect.map((c) => c.ir))
    const session = yield* runSession(text, baseIr, drafted.proposals, ctx).pipe(Effect.provide(runtime.acceptor))
    yield* output.out(`${session.accepted.length} accepted, ${session.rejected.length} rejected.`)
    return session.accepted.length > 0 ? session.text : undefined
  })

const POLICY_REVIEW_NOTE = "The policy is protected: commit it on a branch and get a policy owner's review. Gauntlet judges the change with the base branch's policy."

/**
 * Applies a proposed policy: validates it against the repository, shows
 * what it changes (loosenings marked), writes the policy, and refreshes Claude
 * Code's deny rules when Claude Code is connected. The person runs this, never
 * the agent that proposed it (ADR 0009).
 */
/** Changes to protected files the agent prepared for the person to apply (it can't make them itself). */
export const CHANGES_FILE = "gauntlet.changes.patch"

/**
 * Applies the agent's patch to protected files, after showing it: the same
 * consent as the policy proposal. Never touches .gauntlet/, which changes only
 * through the proposal. Committed on its own, so a reviewer sees it apart.
 */
const applyChanges = (root: string, dryRun: boolean) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const runner = yield* ProcessRunner
    const patch = path.join(root, CHANGES_FILE)
    const text = yield* fs.readFileString(patch).pipe(Effect.option)
    if (Option.isNone(text)) return true
    const files = [...new Set([...text.value.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!.trim()))].sort()
    if (files.length === 0) return yield* fail(`${CHANGES_FILE} changes no files. Ask Claude to write it again.`)
    if (files.some((f) => f === ".gauntlet" || f.startsWith(".gauntlet/"))) {
      return yield* fail(`${CHANGES_FILE} changes .gauntlet/, which changes only through the policy proposal, so nothing was applied.`)
    }
    const check = yield* runner.run({ command: "git", args: ["apply", "--check", CHANGES_FILE], cwd: root })
    if (check.exitCode !== 0) return yield* fail(`${CHANGES_FILE} doesn't apply cleanly, so nothing was changed:\n${check.stderr.trim()}`)
    const diff = yield* runner.run({ command: "git", args: ["apply", "--stat", CHANGES_FILE], cwd: root })
    yield* output.out([style.bold("These changes to protected files will be applied:"), diff.stdout.trimEnd(), "", text.value.trimEnd(), ""].join("\n"))
    if (dryRun) return true
    const applied = yield* runner.run({ command: "git", args: ["apply", CHANGES_FILE], cwd: root })
    if (applied.exitCode !== 0) return yield* fail(`Applying ${CHANGES_FILE} failed: ${applied.stderr.trim()}`)
    yield* fs.remove(patch)
    if (yield* commitIfChanged(root, files, "Changes to protected files for Gauntlet's first baseline")) {
      yield* output.out(style.ok(`Applied and committed the changes to ${files.join(", ")}.`))
    }
    return "applied" as const
  })

const applyProposal = (root: string, from: string, dryRun: boolean) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const compiler = yield* Compiler
    const text = yield* fs.readFileString(path.resolve(root, from)).pipe(Effect.option)
    if (Option.isNone(text)) return yield* fail(`There's no ${from} to apply. In Claude Code, run /gauntlet-setup first; it writes ${PROPOSAL_FILE} for you to apply.`)
    const files = yield* (yield* Git).listWorkingFiles(root).pipe(Effect.option)
    const compiled = yield* Effect.exit(compiler.compile({ file: from, text: text.value, ...(Option.isSome(files) ? { files: files.value } : {}) }))
    if (compiled._tag === "Failure") {
      const diagnostics = compiled.cause.reasons.flatMap((r) => (r._tag === "Fail" && r.error instanceof PolicyInvalid ? r.error.diagnostics : []))
      yield* output.out(formatDiagnostics(diagnostics, text.value))
      return yield* fail(`${from} isn't a valid policy, so nothing was changed. Ask Claude to fix it, or edit it, then run this again.`)
    }
    const target = path.join(root, DEFAULT_POLICY_FILE)
    const current = yield* fs.readFileString(target).pipe(Effect.option)
    const before = Option.isSome(current)
      ? yield* compiler.compile({ file: DEFAULT_POLICY_FILE, text: current.value }).pipe(Effect.map((c) => c.ir), Effect.option)
      : Option.none()
    const changes = describeChanges(compiled.value.ir, Option.getOrUndefined(before))
    if (changes.length === 0) {
      yield* output.out(`${from} matches ${DEFAULT_POLICY_FILE}; nothing to change.`)
    } else {
      yield* output.out([`This will be applied to ${DEFAULT_POLICY_FILE}:`, ...changes.map((c) => `  - ${c}`)].join("\n"))
    }
    if (dryRun) return true
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    yield* fs.writeFileString(target, text.value)
    yield* fs.remove(path.resolve(root, from)).pipe(Effect.orElseSucceed(() => undefined))
    yield* output.out(`\nwrote ${DEFAULT_POLICY_FILE}`)
    // Claude Code's deny rules follow the policy's protected files, so they're refreshed with it.
    const read = (p: string) => fs.readFileString(path.join(root, p)).pipe(Effect.option, Effect.map(Option.getOrUndefined))
    const existingSettings = yield* read(".claude/settings.json")
    if (existingSettings !== undefined) {
      const registry = yield* PackRegistry
      const existingMcp = yield* read(".mcp.json")
      const result = claudeCode({
        ir: compiled.value.ir,
        runnerConfig: runnerConfigFor(registry.packs, compiled.value.ir.packs, compiled.value.ir.builds),
        existingSettings,
        ...(existingMcp !== undefined ? { existingMcp } : {}),
      })
      if (result._tag === "Files") yield* writeGenerated(root, result.files, false)
    }
    return true
  })

const init = Command.make("init", {
  repo: repoFlag,
  name: Flag.optional(Flag.String("name").pipe(Flag.withDescription("the policy's name (default: the directory name)"))),
  owner: ownersFlag,
  template: Flag.Boolean("template").pipe(Flag.withDefault(false), Flag.withDescription("draft from the packs' defaults, without a model")),
  lenient: Flag.Boolean("lenient").pipe(Flag.withDefault(false), Flag.withDescription("ratchets only, without inferred zones, arch rules or floors for new code")),
  force: Flag.Boolean("force").pipe(Flag.withDefault(false), Flag.withDescription("replace an existing policy")),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("print the draft instead of writing it")),
}, (args) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const root = yield* absolute(args.repo)
    const target = path.join(root, DEFAULT_POLICY_FILE)
    if (!args.force && !args.dryRun && (yield* fs.exists(target))) return yield* fail(`${DEFAULT_POLICY_FILE} already exists. Use --force to replace it, or gauntlet validate to check it.`)
    const draft = yield* templateDraft(root, Option.getOrElse(args.name, () => path.basename(root)), ownerList(args.owner), !args.lenient)
    if (draft._tag === "Refused") return yield* fail(draft.reason)
    let text = draft.text
    if (!args.template && !args.dryRun) {
      const setup = yield* authorSetup
      if (setup._tag === "Unavailable") yield* output.err(`Drafting from the packs' defaults (--template): ${setup.reason}`)
      else text = (yield* authorFlow("init", root, draft.text, draft.packs, setup.config, setup.runtime)) ?? draft.text
    }
    if (args.dryRun) {
      yield* output.out(text)
    } else {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, text)
      yield* output.out(`wrote ${DEFAULT_POLICY_FILE} (${draft.packs.join(", ")}, mode shadow)`)
    }
    if (draft.setup.length > 0) yield* output.out(["", "Gates left out until their tools are set up:", ...draft.setup.map((s) => `  - ${s}`)].join("\n"))
    if (!args.dryRun) yield* output.out(["", ...NEXT_STEPS].join("\n"))
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Draft a policy for this repository, in shadow mode."))

// ---------- author ----------

const requireAuthor = Effect.gen(function*() {
  const setup = yield* authorSetup
  if (setup._tag === "Unavailable") yield* fail(`The authoring agent can't run: ${setup.reason}`)
  return setup
})

const authorInit = Command.make("init", {
  repo: repoFlag,
  name: Flag.optional(Flag.String("name").pipe(Flag.withDescription("the policy's name (default: the directory name)"))),
  owner: ownersFlag,
  force: Flag.Boolean("force").pipe(Flag.withDefault(false), Flag.withDescription("replace an existing policy")),
}, (args) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const root = yield* absolute(args.repo)
    const target = path.join(root, DEFAULT_POLICY_FILE)
    if (!args.force && (yield* fs.exists(target))) return yield* fail(`${DEFAULT_POLICY_FILE} already exists. Use gauntlet author review to improve it, or --force to start over.`)
    const setup = yield* requireAuthor
    if (setup._tag === "Unavailable") return
    const draft = yield* templateDraft(root, Option.getOrElse(args.name, () => path.basename(root)), ownerList(args.owner))
    if (draft._tag === "Refused") return yield* fail(draft.reason)
    const text = (yield* authorFlow("init", root, draft.text, draft.packs, setup.config, setup.runtime)) ?? draft.text
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    yield* fs.writeFileString(target, text)
    yield* output.out([`wrote ${DEFAULT_POLICY_FILE} (mode shadow)`, "", ...NEXT_STEPS].join("\n"))
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Draft a policy with the authoring agent; you accept each block."))

const authorReview = Command.make("review", { repo: repoFlag }, (args) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const root = yield* absolute(args.repo)
    const target = path.join(root, DEFAULT_POLICY_FILE)
    const current = yield* fs.readFileString(target).pipe(Effect.option)
    if (Option.isNone(current)) return yield* fail(`No ${DEFAULT_POLICY_FILE} to review. Run gauntlet init first.`)
    const setup = yield* requireAuthor
    if (setup._tag === "Unavailable") return
    const ir = yield* (yield* Compiler).compile({ file: DEFAULT_POLICY_FILE, text: current.value }).pipe(Effect.map((c) => c.ir))
    const text = yield* authorFlow("review", root, current.value, ir.packs, setup.config, setup.runtime)
    if (text === undefined) return
    yield* fs.writeFileString(target, text)
    yield* output.out(`updated ${DEFAULT_POLICY_FILE}. ${POLICY_REVIEW_NOTE}`)
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Critique the policy for gaps and propose cited fixes; you accept each block."))

const authorExplain = Command.make("explain", {
  block: Argument.String("block").pipe(Argument.withDescription("mode, protect, zones, gates, integrity or review")),
  repo: repoFlag,
}, (args) =>
  Effect.gen(function*() {
    const output = yield* Output
    const root = yield* absolute(args.repo)
    const runtime = yield* AuthorRuntime
    const config = authorConfig(runtime.env)
    if (config._tag === "Missing") return yield* fail(`The authoring agent can't run: ${config.reason}`)
    const loaded = yield* (yield* PolicySource).load({ repo: root })
    const facts = explainPolicy(loaded.compiled.ir, args.block)
    if (facts.startsWith("Unknown block")) return yield* fail(facts)
    yield* output.out(yield* explainInPlainLanguage(args.block, loaded.text, facts).pipe(Effect.provide(runtime.model(config.config))))
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Explain in plain language what a policy block enforces."))

const author = Command.make("author").pipe(
  Command.withDescription("The authoring agent: drafts and critiques the policy. It only proposes; you decide."),
  Command.withSubcommands([authorInit, authorReview, authorExplain]),
)

const newProject = Command.make("new", {
  template: Argument.String("template").pipe(Argument.withDescription(TEMPLATES.map((t) => `${t.name}: ${t.description}`).join("; "))),
  directory: Argument.String("directory").pipe(Argument.withDescription("where to create the project (must be empty or missing)")),
  name: Flag.optional(Flag.String("name").pipe(Flag.withDescription("project name (default: the directory name)"))),
  package: Flag.optional(Flag.String("package").pipe(Flag.withDescription("base package (default: from the name)"))),
  owner: Flag.String("owner").pipe(Flag.withDefault("@maintainers"), Flag.withDescription("the policy owner, a GitHub user or team")),
  noGit: Flag.Boolean("no-git").pipe(Flag.withDefault(false), Flag.withDescription("don't run git init")),
}, (args) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const template = TEMPLATES.find((t) => t.name === args.template)
    if (!template) return yield* fail(`Unknown template '${args.template}'. Available: ${TEMPLATES.map((t) => t.name).join(", ")}.`)
    const dir = yield* absolute(args.directory)
    if ((yield* fs.exists(dir)) && (yield* fs.readDirectory(dir)).length > 0) return yield* fail(`${dir} isn't empty. Pick a new directory.`)
    const name = Option.getOrElse(args.name, () => path.basename(dir))
    const vars = { name, package: Option.getOrElse(args.package, () => defaultPackage(name)), owner: args.owner }
    const invalid = invalidVars(vars)
    if (invalid) return yield* fail(`Can't create the project: ${invalid}.`)
    for (const f of renderTemplate(template, vars)) {
      const target = path.join(dir, f.path)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFile(target, f.content)
      if (f.executable) yield* fs.chmod(target, 0o755)
    }
    if (!args.noGit) yield* (yield* Git).init(dir, "main")
    yield* output.out([
      `Created ${name} from ${template.name} in ${dir} (package ${vars.package}, owner ${vars.owner}, mode enforce).`,
      ...(args.owner === "@maintainers" ? ["The policy owner is @maintainers; change `owners` in .gauntlet/policy.gx to your team."] : []),
      "",
      "Next:",
      `  1. cd ${path.relative(process.cwd(), dir) || "."} && ./gradlew test`,
      "  2. Commit everything, then record the baseline: gauntlet baseline, and commit .gauntlet/baseline.sarif.",
      "  3. gauntlet connect github and gauntlet connect claude-code",
    ].join("\n"))
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Create a project from a template with strict defaults, in enforce mode."))

// ---------- connect ----------

/**
 * The project's own formatter, for the files Gauntlet writes: Biome or Prettier
 * when the project configures and installs one. A project whose lint checks
 * formatting would otherwise reject Gauntlet's files and block every change.
 */
const projectFormatter = (root: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const has = (p: string) => fs.exists(path.join(root, p)).pipe(Effect.orElseSucceed(() => false))
    if ((yield* has("biome.json")) || (yield* has("biome.jsonc"))) {
      if (yield* has("node_modules/.bin/biome")) return Option.some(["node_modules/.bin/biome", "format", "--write", "--files-ignore-unknown=true", "--no-errors-on-unmatched"])
    }
    const pkg = yield* fs.readFileString(path.join(root, "package.json")).pipe(Effect.orElseSucceed(() => ""))
    const files = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]))
    const prettierConfigured = files.some((f) => /^(\.prettierrc(\..+)?|prettier\.config\.[cm]?js)$/.test(f)) || /"prettier"\s*:\s*[{"]/.test(pkg)
    if (prettierConfigured && (yield* has("node_modules/.bin/prettier"))) return Option.some(["node_modules/.bin/prettier", "--write", "--ignore-unknown", "--log-level=warn"])
    return Option.none<string[]>()
  })

/** Runs the project's own formatter (Biome or Prettier) over files Gauntlet edited, when it has one. */
const formatWithProject = (root: string, files: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const formatter = yield* projectFormatter(root)
    if (Option.isNone(formatter) || files.length === 0) return
    const [command, ...args] = formatter.value
    yield* (yield* ProcessRunner).run({ command: path.join(root, command!), args: [...args, ...files], cwd: root, timeout: "2 minutes" }).pipe(Effect.ignore)
  })

const writeGenerated = (root: string, files: ReadonlyArray<GeneratedFile>, dryRun: boolean) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const written: { readonly path: string; readonly before: Option.Option<string> }[] = []
    for (const f of files) {
      const target = path.join(root, f.path)
      const existing = yield* fs.readFileString(target).pipe(Effect.option)
      const content = render(f, Option.getOrUndefined(existing))
      if (dryRun) {
        yield* output.out(`--- ${f.path}\n${content}`)
        continue
      }
      // Every generated file goes to the formatter, even one already as rendered:
      // an earlier Gauntlet may have written it before the project had a formatter.
      written.push({ path: f.path, before: existing })
      if (Option.isSome(existing) && existing.value === content) continue
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, content)
      if (f.executable) yield* fs.chmod(target, 0o755)
    }
    if (written.length === 0) return
    const formatter = yield* projectFormatter(root)
    if (Option.isSome(formatter)) {
      const [command, ...args] = formatter.value
      yield* (yield* ProcessRunner).run({ command: path.join(root, command!), args: [...args, ...written.map((w) => w.path)], cwd: root, timeout: "2 minutes" }).pipe(Effect.ignore)
    }
    for (const w of written) {
      // A file that ends up saying exactly what it said before is left unreported.
      const after = yield* fs.readFileString(path.join(root, w.path)).pipe(Effect.option)
      if (Option.isSome(w.before) && Option.isSome(after) && w.before.value === after.value) continue
      yield* output.out(`${Option.isSome(w.before) ? "updated" : "wrote"} ${w.path}`)
    }
  })

const DEFAULT_DOWNLOAD = (version: string) => `https://github.com/matthewjones372/gauntlet/releases/download/v${version}/gauntlet-linux-x64`

/** Requires the `gauntlet` check on the default branch through a repository ruleset, with the GitHub CLI. */
const requireCheck = (root: string, adminBypass: boolean) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const runner = yield* ProcessRunner
    const output = yield* Output
    const gh = (args: ReadonlyArray<string>) => runner.run({ command: "gh", args, cwd: root, timeout: "1 minute" })
    const elsewhere = "Or add it by hand: the repository's Settings, Rules, Rulesets, a ruleset for the default branch that requires the `gauntlet` status check."
    const repo = yield* gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).pipe(Effect.option)
    if (Option.isNone(repo) || repo.value.exitCode !== 0 || repo.value.stdout.trim() === "") {
      return yield* fail(`Requiring the check needs the GitHub CLI (gh), signed in, in a repository with a GitHub remote. ${elsewhere}`)
    }
    const nwo = repo.value.stdout.trim()
    // pull_request_target runs the workflow from the default branch: required before it's there, every pull request waits for a check that never comes.
    const workflow = yield* gh(["api", `repos/${nwo}/contents/.github/workflows/gauntlet.yml`, "-q", ".path"])
    if (workflow.exitCode !== 0) {
      return yield* fail(`.github/workflows/gauntlet.yml isn't on ${nwo}'s default branch yet. Push it first, then run this again; required before then, every pull request would wait for a check that never comes.`)
    }
    const existing = yield* gh(["api", `repos/${nwo}/rulesets`, "-q", '.[] | select(.name == "gauntlet") | .id'])
    const id = existing.exitCode === 0 ? existing.stdout.trim().split("\n")[0] ?? "" : ""
    const body = yield* fs.makeTempFile({ prefix: "gauntlet-ruleset-" })
    yield* fs.writeFileString(body, JSON.stringify(requireCheckRuleset({ adminBypass })))
    const saved = yield* gh(["api", "-X", id ? "PUT" : "POST", id ? `repos/${nwo}/rulesets/${id}` : `repos/${nwo}/rulesets`, "--input", body]).pipe(Effect.ensuring(fs.remove(body).pipe(Effect.ignore)))
    if (saved.exitCode !== 0) {
      return yield* fail(`GitHub refused the ruleset (it needs admin rights on ${nwo}): ${(saved.stderr || saved.stdout).trim()}\n${elsewhere}`)
    }
    yield* output.out(style.ok(`${id ? "Updated" : "Created"} the \`gauntlet\` ruleset on ${nwo}: pull requests into the default branch now need the \`gauntlet\` check to pass.`))
    yield* output.out(adminBypass ? "Repository admins can still push to the default branch directly." : "Nobody can push to the default branch without the check, admins included.")
  })

/**
 * How Gauntlet's GitHub check builds the project as its own CI does
 * (\`.gauntlet/ci.yml\`): the file when it's there, otherwise drafted from the
 * project's workflows, written, and summed up for the person to check.
 */
const ciSetupFor = (root: string, files: ReadonlyArray<string>, ir: PolicyIR, dryRun: boolean) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const existing = yield* fs.readFileString(path.join(root, CI_CONFIG_PATH)).pipe(Effect.option)
    if (Option.isSome(existing)) return parseCiConfig(existing.value)
    const workflows: { path: string; text: string }[] = []
    for (const f of files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) && !f.endsWith("/gauntlet.yml"))) {
      const text = yield* fs.readFileString(path.join(root, f)).pipe(Effect.option)
      if (Option.isSome(text)) workflows.push({ path: f, text: text.value })
    }
    const draft = draftCiConfig(workflows, buildsOf(ir).map((b) => b.dir))
    if (!draft) return Option.none<CiConfig>()
    const text = renderCiConfig(draft)
    if (dryRun) {
      yield* output.out(`--- ${CI_CONFIG_PATH}\n${text}`)
    } else {
      yield* fs.writeFileString(path.join(root, CI_CONFIG_PATH), text)
      yield* output.out([
        `Wrote ${CI_CONFIG_PATH}, so Gauntlet's GitHub check builds this project as your CI does (from ${workflows.map((w) => w.path).join(", ")}):`,
        `  - ${draft.setup.length} setup step${draft.setup.length === 1 ? "" : "s"} first (${[...new Set(draft.setup.map((s) => String(s.name ?? s.uses ?? "a script")))].slice(0, 4).join("; ")}${draft.setup.length > 4 ? "; ..." : ""})`,
        ...Object.entries(draft.builds).map(([dir, b]) => `  - ${dir}: ${[b.wrap, b.tool].filter(Boolean).join(" ") || "as usual"}`),
        "Check it before committing: it's protected, so later changes need an owner.",
      ].join("\n"))
    }
    return Option.some(draft as CiConfig)
  })

/**
 * The project's CI reports as downloaded: one folder per artifact, each
 * holding files under their paths from the repository's root. Only XML and
 * JSON reports, and nothing over 50 MB.
 */
const readCiReports = (dir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entries = yield* fs.readDirectory(dir, { recursive: true }).pipe(Effect.orElseSucceed(() => [] as string[]))
    const out: { path: string; content: string }[] = []
    for (const e of entries.filter((e) => /\.(xml|json|info)$/.test(e)).sort()) {
      const full = path.join(dir, e)
      const info = yield* fs.stat(full).pipe(Effect.option)
      if (Option.isNone(info) || info.value.type !== "File" || Number(info.value.size) > 50_000_000) continue
      const content = yield* fs.readFileString(full).pipe(Effect.option)
      const rel = e.split("/").slice(1).join("/")
      if (Option.isSome(content) && rel !== "") out.push({ path: rel, content: content.value })
    }
    return out
  })

/** The highest \`jvmToolchain(N)\` the Gradle builds ask for, so CI sets up a JDK that can build them. */
const toolchainJava = (root: string, files: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let highest = 0
    for (const f of files.filter((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f))) {
      const text = yield* fs.readFileString(path.join(root, f)).pipe(Effect.orElseSucceed(() => ""))
      for (const m of text.matchAll(/jvmToolchain\(\s*(\d+)\s*\)|JavaLanguageVersion\.of\(\s*(\d+)\s*\)/g)) highest = Math.max(highest, Number(m[1] ?? m[2]))
    }
    return highest > 0 ? Option.some(String(highest)) : Option.none<string>()
  })

const connectGithub = Command.make("github", {
  repo: repoFlag,
  mode: Flag.Literals("mode", ["repo", "org"]).pipe(Flag.withDefault("repo" as const), Flag.withDescription("repo: a pull_request_target workflow here; org: a workflow for a policy repository and an org ruleset")),
  downloadUrl: Flag.optional(Flag.String("download-url").pipe(Flag.withDescription("where CI downloads the gauntlet Linux binary"))),
  sha256: Flag.optional(Flag.String("sha256").pipe(Flag.withDescription("the binary's sha256, pinned in the workflow"))),
  java: Flag.optional(Flag.String("java").pipe(Flag.withDescription("JDK version for the jvm pack (default 21)"))),
  fromSource: Flag.Boolean("from-source").pipe(Flag.withDefault(false), Flag.withDescription("build Gauntlet from the base commit's source instead of downloading it (for the Gauntlet repository itself)")),
  protectOnly: Flag.Boolean("protect-only").pipe(Flag.withDefault(false), Flag.withDescription("judge pull requests with check --protect-only: the verification boundary, pass or fail")),
  requireCheck: Flag.Boolean("require-check").pipe(Flag.withDefault(false), Flag.withDescription("with the GitHub CLI, require the `gauntlet` check on the default branch through a repository ruleset (writes no files; push the workflow first)")),
  adminBypass: Flag.Boolean("admin-bypass").pipe(Flag.withDefault(false), Flag.withDescription("with --require-check: repository admins can still push to the default branch directly")),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("print the files instead of writing them")),
}, (args) =>
  Effect.gen(function*() {
    const root = yield* absolute(args.repo)
    if (args.requireCheck) return yield* requireCheck(root, args.adminBypass)
    const loaded = yield* (yield* PolicySource).load({ repo: root })
    const files = yield* (yield* Git).listWorkingFiles(root)
    const ci = yield* ciSetupFor(root, files, loaded.compiled.ir, args.dryRun)
    yield* writeGenerated(root, github({
      ...(Option.isSome(ci) ? { ciSetup: ci.value.setup } : {}),
      fromSource: args.fromSource,
      ...(args.protectOnly ? { protectOnly: true } : {}),
      mode: args.mode,
      // Protect-only CI sets up only the tools its checks use (no mutation tools, for example).
      ir: args.protectOnly ? protectOnlyIr(loaded.compiled.ir) : loaded.compiled.ir,
      files,
      gauntletVersion: GAUNTLET_VERSION,
      downloadUrl: Option.getOrElse(args.downloadUrl, () => DEFAULT_DOWNLOAD(GAUNTLET_VERSION)),
      ...(Option.isSome(args.sha256) ? { sha256: args.sha256.value } : {}),
      ...(Option.isSome(args.java) ? { javaVersion: args.java.value } : Option.match(yield* toolchainJava(root, files), { onNone: () => ({}), onSome: (v) => ({ javaVersion: v }) })),
    }), args.dryRun)
    if (!args.dryRun) yield* (yield* Output).out("Next: commit and push these files, then run `gauntlet connect github --require-check` to require the `gauntlet` check on the default branch.")
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Generate GitHub enforcement: workflow, CODEOWNERS and the PR check."))

/** Writes Claude Code's hooks, deny rules, MCP server, instructions and /gauntlet-setup for the policy on disk. */
/**
 * Removes Gauntlet's own hooks from a Claude Code settings file, keeping the
 * project's. During setup they stay off: the policy isn't settled yet, and a
 * Stop hook judging a half-set-up project only traps the agent in a loop.
 */
export const withoutGauntletHooks = (settings: string): string => {
  const parsed = JSON.parse(settings) as { hooks?: Record<string, unknown[]> }
  if (!parsed.hooks) return settings
  const hooks: Record<string, unknown[]> = {}
  for (const [event, entries] of Object.entries(parsed.hooks)) {
    const kept = entries.filter((e) => !JSON.stringify(e).includes("gauntlet hook "))
    if (kept.length > 0) hooks[event] = kept
  }
  const { hooks: _, ...rest } = parsed
  return `${JSON.stringify(Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest, null, 2)}\n`
}

const connectClaude = (root: string, dryRun: boolean, options: { readonly hooks?: boolean } = {}) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const loaded = yield* (yield* PolicySource).load({ repo: root })
    const registry = yield* PackRegistry
    const read = (p: string) => fs.readFileString(path.join(root, p)).pipe(Effect.option, Effect.map(Option.getOrUndefined))
    const existingSettings = yield* read(".claude/settings.json")
    const existingMcp = yield* read(".mcp.json")
    const result = claudeCode({
      ir: loaded.compiled.ir,
      runnerConfig: runnerConfigFor(registry.packs, loaded.compiled.ir.packs, loaded.compiled.ir.builds),
      ...(existingSettings !== undefined ? { existingSettings } : {}),
      ...(existingMcp !== undefined ? { existingMcp } : {}),
    })
    if (result._tag === "Unreadable") return yield* fail(`${result.path} isn't a JSON object, so it wasn't changed. Fix it and run this again.`)
    // /gauntlet-fix rides along: `gauntlet apply` offers it when a project's checks already fail.
    const files = options.hooks === false
      ? result.files.map((f) => (f.path === ".claude/settings.json" ? { ...f, content: withoutGauntletHooks(render(f, existingSettings)), mode: "replace" as const } : f))
      : result.files
    yield* writeGenerated(root, [...files, { path: ".claude/commands/gauntlet-fix.md", content: FIX_COMMAND, mode: "replace" }], dryRun)
    return true
  })

const connectClaudeCode = Command.make("claude-code", {
  repo: repoFlag,
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("print the files instead of writing them")),
}, (args) =>
  Effect.gen(function*() {
    yield* connectClaude(yield* absolute(args.repo), args.dryRun)
    if (!args.dryRun) {
      yield* (yield* Output).out("For teams: copy .claude/gauntlet-managed-settings.example.json into managed settings so agents can't turn the hooks off (allowManagedHooksOnly).")
    }
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Set up Claude Code: Stop and PreToolUse hooks, deny rules, MCP server, agent instructions and /gauntlet-setup."))

// ---------- adopt: the one-time window for fixing protected tests ----------

const adopt = Command.make("adopt", {
  repo: repoFlag,
  close: Flag.Boolean("close").pipe(Flag.withDefault(false), Flag.withDescription("close the window and print its report")),
  status: Flag.Boolean("status").pipe(Flag.withDefault(false), Flag.withDescription("say whether the window is open and what was edited")),
}, (args) =>
  Effect.gen(function*() {
    const output = yield* Output
    const root = yield* absolute(args.repo)
    const recorded = yield* readAdoption(root)
    const open = yield* openAdoption(root)
    if (args.status || args.close) {
      if (Option.isNone(recorded)) return yield* output.out("No adoption window is open.")
      yield* output.out(renderAdoptionReport(recorded.value, Option.isSome(open)))
      if (args.close) {
        yield* endAdoption(root)
        yield* output.out("Closed. Protected tests are guarded again.")
      }
      return
    }
    if (Option.isSome(open)) return yield* output.out(`The adoption window is already open (since ${open.value.openedAt}). It closes at your next commit, or with \`gauntlet adopt --close\`.`)
    yield* output.out([
      "This lets your coding agent edit protected tests once, for the first baseline, so a project adopting Gauntlet can fix tests that already fail.",
      "Review every change it makes after setup: `gauntlet adopt --close` lists them.",
      "",
      "  - Only protected tests: .gauntlet/ and protected configuration stay locked.",
      "  - Integrity checks still run, so weakening a test is still caught.",
      "  - Every protected test the agent edits is recorded; `gauntlet adopt --close` prints the report.",
      "  - It closes by itself at your next commit.",
      "  - In CI nothing changes: protected tests are still put back to their base versions.",
      "",
    ].join("\n"))
    // A person at a terminal, not the agent: its shell has no terminal to answer in.
    const reply = yield* (yield* Ask).question("Type 'adopt' to open the window: ")
    if (Option.isNone(reply)) return yield* fail("`gauntlet adopt` needs you at a terminal, so a coding agent can't open it for itself. Run it in your own terminal.")
    if (reply.value !== "adopt") return yield* output.out("Not opened.")
    const now = new Date(yield* Clock.currentTimeMillis).toISOString()
    yield* startAdoption(root, now)
    yield* output.out("Open. Tell your agent it can fix the failing protected tests now, and to report every change. Commit when you're happy; that closes the window.")
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Let the coding agent fix protected tests once, while a project adopts Gauntlet."))

// ---------- setup and apply: the three-step start ----------

/** The files `setup` and `apply` create, committed together by `apply`. */
/** Dependency files `gauntlet setup` may have changed by installing tools; committed with the policy so checks see the tools. */
const DEPENDENCY_FILES = ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "pyproject.toml", "uv.lock", "poetry.lock"]

const SETUP_FILES = [DEFAULT_POLICY_FILE, ".gitignore", "knip.json", "knip.jsonc", ".knip.json", ".knip.jsonc", ".claude/settings.json", ".claude/commands/gauntlet-setup.md", ".claude/commands/gauntlet-fix.md", ".claude/gauntlet-managed-settings.example.json", ".mcp.json", "CLAUDE.md", "AGENTS.md"]

/** Where knip keeps its config, as JSON. */
const KNIP_CONFIGS = ["knip.json", "knip.jsonc", ".knip.json", ".knip.jsonc"]

/**
 * Adds the packages Gauntlet installed to knip's ignoreDependencies, so knip
 * doesn't flag tools only Gauntlet runs. Only JSON configs are edited;
 * anything else is left alone.
 */
export const ignoreInKnip = (root: string, packages: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    if (packages.length === 0) return
    for (const name of KNIP_CONFIGS) {
      const file = path.join(root, name)
      const text = yield* fs.readFileString(file).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const parsed = yield* Effect.try(() => JSON.parse(text.value) as Record<string, unknown>).pipe(Effect.option)
      if (Option.isNone(parsed) || typeof parsed.value !== "object" || parsed.value === null) return
      const existing = Array.isArray(parsed.value.ignoreDependencies) ? parsed.value.ignoreDependencies.filter((d): d is string => typeof d === "string") : []
      const added = packages.filter((p) => !existing.includes(p))
      if (added.length === 0) return
      yield* fs.writeFileString(file, `${JSON.stringify({ ...parsed.value, ignoreDependencies: [...existing, ...added] }, null, 2)}\n`)
      yield* output.out(style.ok(`Told knip about them (${name}), so it doesn't call them unused.`))
      return name
    }
      return undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

/** Claude Code's per-person settings: never committed, so the project's own formatters and linters skip it. */
const keepLocalSettingsOut = (root: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(root, ".gitignore")
    const text = yield* fs.readFileString(file).pipe(Effect.option)
    if (Option.isNone(text) || /^\/?\.claude\/settings\.local\.json\s*$/m.test(text.value) || /^\/?\.claude\/?\s*$/m.test(text.value)) return
    yield* fs.writeFileString(file, `${text.value}${text.value.endsWith("\n") || text.value === "" ? "" : "\n"}.claude/settings.local.json\n`)
  }).pipe(Effect.ignore)

/**
 * Offers to install the tools the draft left out (`uv add --dev ...`), runs the
 * commands when the person says yes (or passed --yes), and says whether anything
 * was installed.
 */
const offerInstall = (root: string, commands: ReadonlyArray<ReadonlyArray<string>>, yes: boolean) =>
  Effect.gen(function*() {
    const output = yield* Output
    if (commands.length === 0) return false
    yield* output.out(["", style.bold("I'll install these for you:"), ...commands.map((c) => `  ${style.command(c.join(" "))}`)].join("\n"))
    if (!yes) {
      const reply = yield* (yield* Ask).question(style.bold("Go ahead? [Y/n] "))
      if (Option.isNone(reply)) {
        yield* output.out("No terminal to ask in, so nothing was installed. Run `gauntlet setup --yes` to install them, or run the commands yourself.")
        return false
      }
      if (!/^(|y|yes)$/i.test(reply.value)) {
        yield* output.out("Nothing installed. Run the commands yourself when you're ready, then `gauntlet setup` again.")
        return false
      }
    }
    const runner = yield* ProcessRunner
    for (const c of commands) {
      yield* output.out(`Running ${c.join(" ")} ...`)
      const r = yield* Effect.exit(runner.run({ command: c[0]!, args: c.slice(1), cwd: root, timeout: "10 minutes" }))
      if (r._tag === "Failure" || r.value.exitCode !== 0) {
        const why = r._tag === "Failure" ? `${c[0]} couldn't be started` : (r.value.stderr.trim() || r.value.stdout.trim()).split("\n").slice(-5).join("\n")
        yield* output.out(`That didn't work, so the policy leaves those checks out for now:\n${why}`)
        return false
      }
    }
    // Tools Gauntlet runs aren't imported by the project's code, so a dependency
    // checker would call them unused and fail the project's own checks.
    const knip = yield* ignoreInKnip(root, commands.flatMap((c) => c.filter((a, i) => i > 0 && !a.startsWith("-") && !["add", "install", "--dev", "-d", "-D", "--group", "dev"].includes(a))).filter((p) => p !== "typescript"))
    if (knip !== undefined) yield* formatWithProject(root, [knip])
    return true
  })

const setup = Command.make("setup", {
  repo: repoFlag,
  owner: ownersFlag,
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription("install missing tools without asking")),
}, (args) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const root = yield* absolute(args.repo)
    const target = path.join(root, DEFAULT_POLICY_FILE)
    const existed = yield* fs.exists(target)
    // A project with a baseline finished setup; running setup again only refreshes Claude Code's files.
    const finished = yield* fs.exists(path.join(root, BASELINE_PATH))
    if (!finished) yield* output.out(`${style.step(2, 3, "Set up your project")}\n`)
    if (existed) {
      yield* output.out(style.ok(`${DEFAULT_POLICY_FILE} already exists; keeping it.`))
    } else {
      let draft = yield* templateDraft(root, path.basename(root), ownerList(args.owner))
      if (draft._tag === "Refused") return yield* fail(draft.reason)
      // Listed once: before the offer, or after drafting when there's nothing to install or it was declined.
      let listed = false
      if (draft.install.length > 0) {
        if (draft.setup.length > 0) yield* output.out([style.warn("Checks left out until their tools are set up:"), ...draft.setup.map(style.item)].join("\n"))
        else yield* output.out(style.warn("Some checks in the draft need tools the project doesn't have installed yet."))
        listed = true
        // Installed tools are now dependencies, so a fresh draft gates them.
        if (yield* offerInstall(root, draft.install, args.yes)) {
          listed = false
          const again = yield* templateDraft(root, path.basename(root), ownerList(args.owner))
          if (again._tag === "Draft") draft = again
          yield* output.out(style.ok("Installed. `gauntlet apply` commits them with the policy."))
        }
        yield* output.out("")
      }
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, draft.text)
      yield* output.out(style.ok(`Drafted ${DEFAULT_POLICY_FILE} for ${draft.packs.join(", ")} ${style.dim("(shadow mode: it reports, it never blocks)")}.`))
      if (draft.setup.length > 0 && !listed) yield* output.out([style.warn("Checks still left out until their tools are set up:"), ...draft.setup.map(style.item)].join("\n"))
    }
    // Gauntlet's hooks switch on at the end of `gauntlet apply`, once the policy is settled.
    // A project that finished setup (it has a baseline) keeps them.
    if (!(yield* connectClaude(root, false, finished ? {} : { hooks: false }))) return
    yield* keepLocalSettingsOut(root)
    if (finished) {
      return yield* output.out([
        style.ok("Gauntlet is already set up here; Claude Code's files are up to date."),
        `To change the policy, open Claude Code here and type ${style.command("/gauntlet-setup")}.`,
      ].join("\n"))
    }
    yield* output.out([
      style.ok("Connected Claude Code."),
      "",
      style.step(3, 3, "Agree the rules with Claude"),
      "",
      `Last step: open Claude Code here and type ${style.command("/gauntlet-setup")}. It goes through the policy with you,`,
      `then tells you to run ${style.command("gauntlet apply")}. ${style.dim(`(Or run gauntlet apply now to ${existed ? "keep the current policy" : "use the draft as it is"}.)`)}`,
    ].join("\n"))
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Draft a policy for this repository and connect Claude Code: step 2 of 3."))

class StepFailed extends Data.TaggedError("StepFailed")<{ readonly message: string }> {}

/** Runs git in the repository with the person's own identity; returns stdout, or fails with git's message. */
const runGit = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const r = yield* (yield* ProcessRunner).run({ command: "git", args, cwd: root })
    if (r.exitCode !== 0) {
      const message = /Author identity unknown|Please tell me who you are|unable to auto-detect email/.test(r.stderr)
        ? "git doesn't know who you are, so it can't commit. Set your name and email, then run this again:\n  git config --global user.name \"Your Name\"\n  git config --global user.email \"you@example.com\""
        : `git ${args[0]} failed: ${r.stderr.trim()}`
      return yield* Effect.fail(new StepFailed({ message }))
    }
    return r.stdout
  })

/** Stages `paths` that exist and commits them if anything changed; says whether it committed. */
const commitIfChanged = (root: string, paths: ReadonlyArray<string>, message: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const present: string[] = []
    for (const p of paths) if (yield* fs.exists(path.join(root, p))) present.push(p)
    if (present.length === 0) return false
    yield* runGit(root, ["add", "--", ...present])
    const staged = yield* runGit(root, ["diff", "--cached", "--name-only", "--", ...present])
    if (staged.trim() === "") return false
    yield* runGit(root, ["commit", "-q", "-m", message, "--", ...present])
    return true
  })

const apply = Command.make("apply", {
  repo: repoFlag,
  from: Flag.optional(Flag.String("from").pipe(Flag.withDescription(`the proposed policy (default: ${PROPOSAL_FILE}, written by /gauntlet-setup)`))),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("show what would change, and change nothing")),
}, (args) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const root = yield* absolute(args.repo)
    const from = Option.getOrElse(args.from, () => PROPOSAL_FILE)
    // Setup's commits never land on the default branch: they reach it through a pull request, where the checks run.
    if (!args.dryRun) yield* onSetupBranch(root)
    // Protected-file changes the agent prepared go first, so the baseline is recorded after them.
    const changes = yield* applyChanges(root, args.dryRun)
    if (!changes) return
    // Setup is finishing, so an adoption window left open closes here, with its record.
    const window = yield* readAdoption(root)
    if (Option.isSome(window) && !args.dryRun) {
      yield* output.out(renderAdoptionReport(window.value, Option.isSome(yield* openAdoption(root))))
      yield* endAdoption(root)
      yield* output.out(style.ok("Closed the adoption window: protected tests are guarded again."))
    }
    if (yield* fs.exists(path.resolve(root, from))) {
      if (!(yield* applyProposal(root, from, args.dryRun))) return
    } else if (Option.isSome(args.from)) {
      return yield* fail(`There's no ${from} to apply.`)
    } else if (!(yield* fs.exists(path.join(root, DEFAULT_POLICY_FILE)))) {
      return yield* fail("There's no policy yet. Run `gauntlet setup` first.")
    } else {
      yield* output.out(`No proposal from /gauntlet-setup, so ${DEFAULT_POLICY_FILE} stays as it is.`)
    }
    if (args.dryRun) return
    if (yield* commitIfChanged(root, [...SETUP_FILES, ...DEPENDENCY_FILES], "Add Gauntlet")) yield* output.out("Committed the policy, the Claude Code files and any tools setup installed.")
    yield* offerCodeowners(root, (yield* (yield* PolicySource).load({ repo: root, baseRef: "HEAD" })).compiled.ir)
    const recordedBaseline = yield* fs.readFileString(path.join(root, BASELINE_PATH)).pipe(Effect.option)
    const policyHash = (yield* (yield* PolicySource).load({ repo: root, baseRef: "HEAD" })).compiled.hash
    // A baseline records the policy's hash; another hash means the policy changed since.
    const recordedHash = Option.isSome(recordedBaseline) ? (yield* Effect.option(decodeBaseline(recordedBaseline.value))).pipe(Option.map((b) => b.irHash)) : Option.none<string>()
    // Protected-file changes can set up a gate's tool (an sbt plugin, a linter config), so its existing findings are recorded too.
    const stale = Option.isSome(recordedBaseline) && (Option.getOrUndefined(recordedHash) !== policyHash || changes === "applied")
    if (Option.isSome(recordedBaseline) && !stale) {
      yield* output.out(`${BASELINE_PATH} is already recorded for this policy.`)
      yield* switchOnHooks(root)
    } else if (Option.isSome(recordedBaseline)) {
      // The policy changed since the baseline: record the new gates' existing findings, or every change would fail on them.
      yield* output.out(changes === "applied"
        ? "The changes can set up tools that weren't there, so the baseline is recorded again for the gates they let run."
        : "The policy changed since the baseline was recorded, so it's recorded again for the new gates.")
      const recorded = yield* runBaseline({ repo: root, update: true, allowLower: false, adoptNewGates: true, importDetekt: Option.none(), trunk: yield* setupTrunk(root), commitHint: false, skipChangedMutation: true })
      if (!recorded) return
      if (yield* commitIfChanged(root, [BASELINE_PATH], "Update Gauntlet baseline for the new gates")) yield* output.out("Committed the baseline.")
      yield* switchOnHooks(root)
      yield* output.out(`\n${style.ok(style.bold("Done."))} Claude Code now checks its work with Gauntlet before it finishes.${yield* pullRequestHint(root)}`)
      const failing = persistentFailures(recorded.checks, recorded.ir)
      if (failing.length > 0) yield* offerFix(root, failing)
      return
    } else {
      const recorded = yield* runBaseline({ repo: root, update: false, allowLower: false, importDetekt: Option.none(), trunk: yield* setupTrunk(root), commitHint: false, skipChangedMutation: true })
      if (!recorded) return
      // Gauntlet's hooks switch on with the baseline: the last step of setup.
      if (!(yield* connectClaude(root, false))) return
      if (yield* commitIfChanged(root, [BASELINE_PATH, ".claude/settings.json"], "Record Gauntlet baseline")) {
        yield* output.out("Committed the baseline, and switched on Gauntlet's Claude Code hooks.")
      }
      const failing = persistentFailures(recorded.checks, recorded.ir)
      yield* output.out(`${firstRunExplained(recorded.ir.mode, failing.length > 0)}${yield* pullRequestHint(root)}`)
      if (failing.length > 0) yield* offerFix(root, failing)
      return
    }
    yield* output.out(`\n${style.ok(style.bold("Done."))} Claude Code now checks its work with Gauntlet before it finishes.${yield* pullRequestHint(root)}`)
  }).pipe(withGateProgress, Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Apply the policy, commit it and record the baseline: the end of step 3."))

const connect = Command.make("connect").pipe(Command.withDescription("Connect Gauntlet to GitHub or a coding agent."), Command.withSubcommands([connectGithub, connectClaudeCode]))

// ---------- github-status (the trusted job) ----------

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(Report))
const decodeReviews = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Review)))
const decodeComments = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(PrComment)))
const decodeTeams = Schema.decodeUnknownOption(Schema.fromJsonString(Teams))

const githubStatusCommand = Command.make("github-status", {
  repo: repoFlag,
  policyRef: Flag.String("policy-ref"),
  head: Flag.String("head"),
  evidence: Flag.String("evidence").pipe(Flag.withDescription("the evidence job's gauntlet-report.json")),
  reviews: Flag.String("reviews").pipe(Flag.withDescription("the PR's reviews as [{user, state, commitId}]")),
  teams: Flag.optional(Flag.String("teams").pipe(Flag.withDescription("owner team members as {\"@org/team\": [logins]}"))),
  comments: Flag.optional(Flag.String("comments").pipe(Flag.withDescription("the PR's comments as [{user, body}], for owners' `/gauntlet approve <commit>`"))),
  out: Flag.String("out"),
  record: Flag.Boolean("record").pipe(Flag.withDefault(false), Flag.withDescription("append the shadow record (git note)")),
  protectOnly: Flag.Boolean("protect-only").pipe(Flag.withDefault(false), Flag.withDescription("judge as check --protect-only")),
}, (args) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const output = yield* Output
    const root = yield* absolute(args.repo)
    const read = (p: string) => fs.readFileString(path.resolve(root, p)).pipe(Effect.option)
    const evidence = Option.flatMap(yield* read(args.evidence), decodeReport)
    if (Option.isNone(evidence)) yield* output.err("No readable evidence report: every check counts as not executed.")
    const head = yield* (yield* Git).revParse(root, args.head)
    const report = yield* judgeWithEvidence({
      repo: root, policyRef: args.policyRef, head, outDir: path.resolve(root, args.out), gauntletVersion: GAUNTLET_VERSION, record: args.record,
      ...(args.protectOnly ? { protectOnly: true } : {}),
      ...(Option.isSome(evidence) ? { evidence: evidence.value } : {}),
    })
    const reviews = Option.getOrElse(Option.flatMap(yield* read(args.reviews), decodeReviews), () => [])
    const teams = Option.isSome(args.teams) ? Option.getOrElse(Option.flatMap(yield* read(args.teams.value), decodeTeams), () => ({})) : {}
    const overrides = yield* (yield* Overrides).forHead(root, head)
    const comments = Option.isSome(args.comments) ? Option.getOrElse(Option.flatMap(yield* read(args.comments.value), decodeComments), () => []) : []
    const status = githubStatus(report, reviews, teams, overrides, comments)
    yield* fs.writeFileString(path.resolve(root, args.out, "status.json"), `${JSON.stringify(status, null, 2)}\n`)
    // The report posted on the pull request says who approved, under its first line, and shows its box ticked.
    if (status.conclusion === "success" && status.approvedBy.length > 0) {
      const md = path.resolve(root, args.out, "gauntlet-report.md")
      const text = yield* fs.readFileString(md).pipe(Effect.option)
      if (Option.isSome(text)) {
        const [first, ...rest] = text.value.split("\n")
        const who = `approved by ${status.approvedBy.join(", ")}`
        const ticked = rest.map((l) => (l.startsWith(`- [ ] ${APPROVE_BOX}`) ? `- [x] ${APPROVE_BOX}: ${who} (commit \`${head.slice(0, 12)}\`)` : l))
        yield* fs.writeFileString(md, [first, "", `**${status.title}** for commit \`${head.slice(0, 12)}\`.`, ...ticked].join("\n"))
      }
    }
    yield* output.out(`${status.conclusion}: ${status.title}. ${status.summary}`)
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("CI's trusted job: recompute what needs no execution, then decide the gauntlet check."))

// ---------- doctor ----------

/**
 * Whether a change needs building: false when it only edits comments or
 * documentation (ADR 0023). The GitHub workflow asks first, so a comment
 * change skips the toolchain and the project's CI setup as well as the checks.
 */
const needsBuild = Command.make("needs-build", {
  repo: repoFlag,
  policyRef: Flag.String("policy-ref").pipe(Flag.withDescription("the base commit")),
  head: Flag.String("head"),
}, (args) =>
  Effect.gen(function*() {
    const root = yield* absolute(args.repo)
    const git = yield* Git
    const base = yield* git.revParse(root, args.policyRef)
    const head = yield* git.revParse(root, args.head)
    const changes = yield* git.diff(root, base, head)
    const unchanged = yield* changeLeavesBehaviour(git, root, base, head, changes.map((c) => ({ path: c.path, status: c.status })))
    yield* (yield* Output).out(unchanged ? "false" : "true")
    // Anything unclear (no base, a git failure) means build: never skip on a guess.
  }).pipe(Effect.catch(() => Effect.gen(function*() {
    yield* (yield* Output).out("true")
  }))),
).pipe(Command.withDescription("Print false when a change only edits comments or documentation, true otherwise (for the GitHub workflow)."))

const doctor = Command.make("doctor", { repo: repoFlag }, (args) =>
  Effect.gen(function*() {
    const root = yield* absolute(args.repo)
    const checks = [
      { what: "gauntlet", ok: true, detail: `v${GAUNTLET_VERSION}` },
      ...(yield* runDoctor(root)),
      { what: "templates", ok: TEMPLATES.length > 0 && TEMPLATES.every((t) => t.files.length > 0), detail: TEMPLATES.map((t) => `${t.name} (${t.files.length} files)`).join(", ") },
      { what: "mcp tools", ok: Object.keys(GauntletTools.tools).length > 0, detail: Object.keys(GauntletTools.tools).join(", ") },
    ]
    yield* (yield* Output).out(renderDoctor(checks))
    if (checks.some((c) => !c.ok && !("optional" in c && c.optional))) yield* exitWith(1)
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Check that this build and machine can run Gauntlet."))

// ---------- mcp ----------

const mcp = Command.make("mcp", { repo: repoFlag }, (args) =>
  Effect.gen(function*() {
    const root = yield* absolute(args.repo)
    // stdout carries the protocol from here on: nothing else may print to it.
    // Runs until the client closes stdin, which ends the program with an interruption (main.ts exits 0 for it).
    yield* Layer.launch(mcpServer({ repo: root, gauntletVersion: GAUNTLET_VERSION, env: process.env }).pipe(Layer.provide(BunStdio.layer)))
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Serve Gauntlet's tools to a coding agent over MCP (stdio)."))

// ---------- hooks (Claude Code) ----------

const readStdin = Effect.gen(function*() {
  return yield* (yield* Stdin).text
})
const decodeHookInput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  cwd: Schema.optionalKey(Schema.String),
  stop_hook_active: Schema.optionalKey(Schema.Boolean),
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Struct({ file_path: Schema.optionalKey(Schema.String), notebook_path: Schema.optionalKey(Schema.String), command: Schema.optionalKey(Schema.String) })),
})))

/** The current branch and the branches nothing may be pushed to directly: the remote's default, main and master. */
const branches = (root: string) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const git = (args: ReadonlyArray<string>) => runner.run({ command: "git", args, cwd: root }).pipe(Effect.map((r) => (r.exitCode === 0 ? r.stdout.trim() : "")), Effect.orElseSucceed(() => ""))
    const current = yield* git(["rev-parse", "--abbrev-ref", "HEAD"])
    const remote = (yield* git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "")
    return { current, defaults: [...new Set([remote, "main", "master"].filter(Boolean))] }
  })

const hookStop = Command.make("stop", {}, () =>
  Effect.gen(function*() {
    const output = yield* Output
    const input = Option.getOrElse(decodeHookInput(yield* readStdin), () => ({}) as { cwd?: string; stop_hook_active?: boolean })
    // Already blocked once in this stop: let the agent stop rather than loop.
    if (input.stop_hook_active) return
    const root = input.cwd ?? process.cwd()
    // Nothing but Gauntlet's own setup files changed: no code to judge, and failures
    // already in the project aren't this agent's to fix (they'd trap it in a loop).
    if (yield* nothingToJudge(root)) return
    const git = yield* Git
    const outDir = `${yield* git.gitDir(root)}/gauntlet/hook`
    // While the adoption window is open, the agent's fixes to protected tests are what's judged.
    const adoption = Option.isSome(yield* openAdoption(root))
    const result = yield* Effect.exit(checkWorkingTree({ repo: root, outDir, gauntletVersion: GAUNTLET_VERSION, agent: agentFromEnv(process.env), ...(adoption ? { adoption: true } : {}) }))
    // If Gauntlet can't run here (no policy, no base), don't trap the agent; CI still decides.
    if (result._tag === "Failure") return
    // The agent reported it's blocked on exactly this state: a person decides now.
    if (result.value.blocked) return
    if (!result.value.report.decision.wouldBlock) return
    const reason = renderAgentSummary(agentSummary(result.value.report, outDir))
    yield* output.out(JSON.stringify({ decision: "block", reason }))
  })).pipe(Command.withDescription("Claude Code Stop hook: block completion while Gauntlet would block the change."))

const hookPreToolUse = Command.make("pre-tool-use", {}, () =>
  Effect.gen(function*() {
    const output = yield* Output
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const input = Option.getOrUndefined(decodeHookInput(yield* readStdin))
    // A change reaches the default branch only through a pull request, where the checks run.
    if (input?.tool_name === "Bash" && input.tool_input?.command !== undefined) {
      if (!/\bgit\b[^\n]*\bpush\b/.test(input.tool_input.command)) return
      const { current, defaults } = yield* branches(input.cwd ?? process.cwd())
      const hit = pushTarget(input.tool_input.command, current, defaults)
      if (hit === undefined) return
      const branch = current !== "" && !defaults.includes(current) ? current : "<a new branch>"
      yield* output.out(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `This pushes to ${hit}. Changes reach ${hit} only through a pull request, where the checks run. Commit on a branch (git switch -c <name> if you're on ${hit}), push it (git push -u origin ${branch}) and open a pull request (gh pr create), after asking the person.`,
        },
      }))
      return
    }
    const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path
    if (!input || !target) return
    const cwd = input.cwd ?? process.cwd()
    const git = yield* Git
    const top = yield* git.topLevel(cwd).pipe(Effect.option)
    if (Option.isNone(top)) return
    // git prints the real path (macOS /var is /private/var); resolve the target the same way,
    // through its nearest existing ancestor, since the file and its directories may be new.
    const realTarget = (p: string): Effect.Effect<string> =>
      fs.realPath(p).pipe(Effect.catch(() => path.dirname(p) === p ? Effect.succeed(p) : realTarget(path.dirname(p)).pipe(Effect.map((d) => path.join(d, path.basename(p))))))
    const relative = path.relative(top.value, yield* realTarget(path.resolve(cwd, target)))
    if (relative.startsWith("..")) return
    // Gauntlet's own state (the adoption window, blocked reports) is the person's, never the agent's.
    if (relative.startsWith(".git/")) {
      yield* output.out(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${relative} is inside .git, which the agent doesn't edit.` } }))
      return
    }
    const loaded = yield* Effect.option((yield* PolicySource).load({ repo: top.value }))
    if (Option.isNone(loaded)) return
    const registry = yield* PackRegistry
    const hit = protectionFor(relative, loaded.value.compiled.ir.protect, runnerConfigFor(registry.packs, loaded.value.compiled.ir.packs, loaded.value.compiled.ir.builds))
    if (!hit) return
    // Tests are the agent's to write and, when a requirement changes, to change: a new test runs, and an
    // edited one runs as edited and puts the change up for review. Integrity checks still catch weakening.
    if (hit.kind === "tests") {
      const exists = yield* fs.exists(path.join(top.value, relative)).pipe(Effect.orElseSucceed(() => true))
      // The adoption window (spec 0005) keeps its record of the protected tests edited while it's open.
      if (exists && Option.isSome(yield* openAdoption(top.value))) yield* recordAdoptionEdit(top.value, relative)
      return
    }
    yield* output.out(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${relative} is protected by the Gauntlet policy (${hit.group}). In CI it is put back to the base version, so editing it can't make a check pass, and changing it needs ${hit.kind === "gauntlet" ? "an owner" : "review"}. If the task needs it changed, call the report_blocked tool with the reason.`,
      },
    }))
  })).pipe(Command.withDescription("Claude Code PreToolUse hook: deny edits to protected files."))

const hook = Command.make("hook").pipe(Command.withDescription("Hooks for coding agents."), Command.withSubcommands([hookStop, hookPreToolUse]))

// ---------- report shadow ----------

const shadow = Command.make("shadow", {
  repo: repoFlag,
  since: Flag.optional(Flag.String("since").pipe(Flag.withDescription("only checks recorded on or after this date (YYYY-MM-DD)"))),
  json: jsonFlag,
}, ({ repo, since, json }) =>
  Effect.gen(function*() {
    const root = yield* absolute(repo)
    const summary = summariseShadow(yield* (yield* ShadowLog).read(root), Option.getOrUndefined(since))
    yield* (yield* Output).out(json ? prettyCanonicalJson(summary) : renderShadowSummary(summary))
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Summarise what Gauntlet would have done during the shadow period."))

const blockedCommand = Command.make("blocked", {
  repo: repoFlag,
  reason: Flag.String("reason").pipe(Flag.withDescription("what the task needs that the policy protects, and why")),
  path: Flag.optional(Flag.String("path").pipe(Flag.withDescription("protected paths the task would need to change, comma-separated"))),
}, (args) =>
  Effect.gen(function*() {
    const root = yield* absolute(args.repo)
    if (args.reason.trim().length < 10) return yield* fail("Give a reason a person can act on: what needs to change and why.")
    const paths = Option.match(args.path, { onNone: () => [], onSome: (p) => p.split(",").map((x) => x.trim()).filter((x) => x !== "") })
    const record = yield* recordBlocked(root, { reason: args.reason.trim(), paths, at: new Date().toISOString() })
    yield* (yield* Output).out(BLOCKED_ACK(record.reason))
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("Agents: report that the task can't be done without changing protected tests or policy."))

const flaky = Command.make("flaky", { repo: repoFlag, json: jsonFlag }, ({ repo, json }) =>
  Effect.gen(function*() {
    const root = yield* absolute(repo)
    const summary = summariseFlaky(yield* (yield* ShadowLog).readAll(root))
    yield* (yield* Output).out(json ? prettyCanonicalJson(summary) : renderFlaky(summary))
  }).pipe(Effect.catch((e) => fail(describeFailure(e))))).pipe(Command.withDescription("List tests that both passed and failed on identical code."))

const report = Command.make("report").pipe(Command.withDescription("Reports over recorded checks, and the agent's blocked report."), Command.withSubcommands([shadow, flaky, blockedCommand]))

export const root = Command.make("gauntlet").pipe(
  Command.withDescription("Gauntlet: verification integrity for agent-written code."),
  Command.withSubcommands([setup, apply, adopt, validate, check, explain, init, newProject, author, baseline, selftest, corpus, override, report, connect, githubStatusCommand, needsBuild, hook, mcp, doctor]),
)

/** Runs the CLI on `args` (without the program name) and returns the exit code. */
export const runCli = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const status = yield* ExitStatus
    yield* Command.runWith(root, { version: GAUNTLET_VERSION })(args).pipe(
      Effect.catch(() => exitWith(2)),
    )
    return yield* Ref.get(status)
  })
