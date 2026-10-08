import type { Check } from "@gauntlet/ir"
import type { GateSpec, PackSpec } from "./catalog.ts"
import { type Draft, type Ref, type Report, spanOfNode } from "./compile.ts"
import type { Span } from "./span.ts"
import { closest, didYouMean, quoteList } from "./suggest.ts"
import { FACT_CONDITIONS, INTEGRITY_PHRASES } from "./vocabulary.ts"

// Checks that need the pack catalog or the whole policy: names resolve,
// gates accept what the policy says about them, references point somewhere.

const NOT_EXECUTED = "It is parsed and validated but not executed in v1, so it is reported as missing evidence and nominates review."

const phraseOf = (id: string): string => {
  for (const table of Object.values(INTEGRITY_PHRASES)) {
    for (const [phrase, value] of Object.entries(table)) if (value === id) return phrase
  }
  return id
}

export const resolve = (draft: Draft, installed: ReadonlyArray<PackSpec>, report: Report): void => {
  const { ir, refs, spans } = draft
  const error = (code: string, span: Span, message: string, expected: string, fix: string, available?: ReadonlyArray<string>) =>
    report({ severity: "error", code, span, message, expected, fix, ...(available ? { available: [...available] } : {}) })
  const warning = (code: string, span: Span, message: string, expected: string, fix: string) =>
    report({ severity: "warning", code, span, message, expected, fix })
  const info = (code: string, span: Span, message: string, fix: string) =>
    report({ severity: "info", code, span, message, expected: "nothing; this is for information", fix })

  const of = <K extends Ref["kind"]>(kind: K) => refs.filter((r): r is Extract<Ref, { kind: K }> => r.kind === kind)
  const installedNames = installed.map((p) => p.name)

  // ---------- packs ----------

  const used: PackSpec[] = []
  const seenPacks = new Set<string>()
  for (const ref of of("pack")) {
    if (seenPacks.has(ref.name)) {
      warning("duplicate-pack", ref.span, `Pack '${ref.name}' is listed twice.`, "each pack once", `Remove the second '${ref.name}'.`)
      continue
    }
    seenPacks.add(ref.name)
    const pack = installed.find((p) => p.name === ref.name)
    if (pack) {
      used.push(pack)
      continue
    }
    const owner = installed.find((p) => p.rules.some((r) => r.name.startsWith(`${ref.name}.`)))
    const fix = owner
      ? `'${ref.name}.*' rules come from the '${owner.name}' pack. Write \`use ${owner.name}\`.`
      : didYouMean(ref.name, installedNames, installedNames.length > 0
        ? `Use one of the installed packs: ${quoteList(installedNames)}.`
        : "No packs are installed in this build of Gauntlet.")
    error("unknown-pack", ref.span, `Unknown pack '${ref.name}'.`,
      installedNames.length > 0 ? `an installed pack: ${quoteList(installedNames)}` : "an installed pack (none are installed)", fix, installedNames)
  }
  const usedGates = used.flatMap((p) => p.gates.map((g) => ({ pack: p.name, gate: g })))
  const usedRules = used.flatMap((p) => p.rules.map((r) => r.name))

  // ---------- zone rules ----------

  for (const ref of of("rule")) {
    if (usedRules.includes(ref.name)) continue
    const elsewhere = installed.find((p) => p.rules.some((r) => r.name === ref.name))
    if (elsewhere) {
      error("pack-not-used", ref.span, `Rule '${ref.name}' comes from pack '${elsewhere.name}', which this policy doesn't use.`,
        `a rule from a used pack (${quoteList(used.map((p) => p.name))})`, `Add \`use ${elsewhere.name}\`.`)
      continue
    }
    const all = installed.flatMap((p) => p.rules.map((r) => r.name))
    error("unknown-rule", ref.span, `Unknown rule '${ref.name}' in zone '${ref.zone}'.`, "a rule provided by a used pack",
      didYouMean(ref.name, all, all.length > 0 ? `Use one of ${quoteList(usedRules.length > 0 ? usedRules : all)}.` : "No installed pack provides rules."),
      usedRules)
  }

  // ---------- suites ----------

  for (const suite of ir.suites) {
    const clash = usedGates.find((g) => g.gate.name === suite.name)
    if (clash) {
      error("suite-shadows-gate", spanOfNode(suite)!, `Suite '${suite.name}' has the same name as a gate from pack '${clash.pack}'.`,
        "a suite name that isn't a gate name", `Rename the suite, for example '${suite.name}-tests'.`)
    }
    if (suite.kind === "holdout" && suite.globs !== undefined) {
      info("holdout-ci-only", spanOfNode(suite)!, `Holdout '${suite.name}' runs only in the CI evidence job (\`gauntlet check --holdouts\`) and shows as "holdout pending" everywhere else. Its files are left out of every other run.`,
        "Nothing to fix.")
    } else if (suite.kind === "holdout") {
      info("not-executed-in-v1", spanOfNode(suite)!, `Holdout '${suite.name}' runs only in CI and shows as "holdout pending" locally. ${NOT_EXECUTED}`,
        "Nothing to fix. Remove the holdout if changes should be able to reach auto or skim in v1.")
    }
  }

  // ---------- gate checks ----------

  const checkNames = new Map<string, { tier: string; span: Span }>()
  const runsSuites = used.some((p) => p.runsSuites)
  for (const ref of of("check")) {
    const previous = checkNames.get(ref.name)
    if (previous) {
      warning("duplicate-check", ref.span, `'${ref.name}' already runs in tier '${previous.tier}' (line ${previous.span.line}).`,
        "each check once", `Remove this '${ref.name}'.`)
    } else checkNames.set(ref.name, { tier: ref.tier, span: ref.span })
    checkGate(ref.check, ref.span)
  }

  function checkGate(check: Check, span: Span) {
    switch (check.kind) {
      case "suite":
        if (!runsSuites) {
          error("no-suite-runner", span, `Suite '${check.name}' needs a pack that runs test suites, and no used pack does.`,
            "a used pack that runs suites", installed.some((p) => p.runsSuites)
              ? `Add \`use ${installed.find((p) => p.runsSuites)!.name}\`.`
              : "Install a pack that runs suites.")
        }
        return
      case "holdout":
        return
      case "budget":
        return
      case "llm-review":
        info("not-executed-in-v1", span, `\`llm review\` is caution-only. ${NOT_EXECUTED}`,
          "Nothing to fix. Remove it if changes should be able to reach auto or skim in v1.")
        return
      case "gate":
        gate(check, span)
    }
  }

  function gate(check: Extract<Check, { kind: "gate" }>, span: Span) {
    const hit = usedGates.find((g) => g.gate.name === check.name)
    if (!hit) {
      const elsewhere = installed.find((p) => p.gates.some((g) => g.name === check.name))
      if (elsewhere) {
        error("pack-not-used", span, `Gate '${check.name}' comes from pack '${elsewhere.name}', which this policy doesn't use.`,
          "a gate from a used pack or a declared suite", `Add \`use ${elsewhere.name}\`.`)
        return
      }
      const candidates = [...usedGates.map((g) => g.gate.name), ...ir.suites.map((s) => s.name)]
      error("unknown-gate", span, `Unknown gate '${check.name}'.`, "a gate from a used pack, or a suite declared in `suites`",
        didYouMean(check.name, candidates, candidates.length > 0
          ? `Use one of ${quoteList(candidates)}, or declare '${check.name}' in \`suites\`.`
          : "No used pack provides gates. Add `use <pack>` first."), candidates)
      return
    }
    const spec: GateSpec = hit.gate
    if (check.ratchet && spec.produces === "outcome") {
      error("cannot-ratchet", span, `'${check.name}' only passes or fails, so there is nothing to ratchet.`, `'${check.name}' without \`ratchet\``,
        "Remove `ratchet`.")
    }
    if (check.threshold) {
      const { op, value } = check.threshold
      const amount = `${value.value}${value.unit ?? ""}`
      if (spec.produces !== "metric") {
        error("no-threshold", span, `'${check.name}' doesn't produce a number, so it can't take '${op} ${amount}'.`,
          `'${check.name}'${spec.produces === "violations" ? " or '" + check.name + " ratchet'" : ""}`,
          spec.produces === "violations" ? "Use `ratchet` to stop new violations, and remove the threshold." : "Remove the threshold.")
      } else if (value.unit === undefined || !spec.units.includes(value.unit)) {
        error("wrong-unit", span, `'${check.name}' is measured in ${quoteList(spec.units)}, so '${amount}' can't apply.`,
          `a unit from ${quoteList(spec.units)}`, `Write the amount with a unit, for example ${value.value}${spec.units[0] ?? ""}.`, spec.units)
      } else if (value.unit === "%" && value.value > 100) {
        error("percent-out-of-range", span, `${value.value}% is more than 100%.`, "a percentage between 0 and 100", "Use a value between 0% and 100%.")
      } else if (spec.higherIsBetter && !(op === ">=" || op === ">")) {
        error("wrong-direction", span, `Higher '${check.name}' is better, so the threshold is a minimum.`, "'>=' or '>'",
          `Write: ${check.name} >= ${amount}`)
      } else if (!spec.higherIsBetter && !(op === "<=" || op === "<")) {
        error("wrong-direction", span, `Lower '${check.name}' is better, so the threshold is a maximum.`, "'<=' or '<'",
          `Write: ${check.name} <= ${amount}`)
      }
    }
    if (check.scope === "changed" && !spec.scopable) {
      error("not-scopable", span, `'${check.name}' always runs on the whole project; it can't be limited with \`on changed\`.`,
        `'${check.name}' without \`on changed\``, "Remove `on changed`.")
    }
    if (check.zone !== undefined && !spec.zoneScopable) {
      error("not-zone-scopable", span, `'${check.name}' can't be limited to a zone.`, `'${check.name}' without \`in zone\``, `Remove \`in zone ${check.zone}\`.`)
    }
  }

  // ---------- references ----------

  const zoneNames = ir.zones.map((z) => z.name)
  for (const ref of of("zone-ref")) {
    if (!zoneNames.includes(ref.name)) {
      error("unknown-zone", ref.span, `Unknown zone '${ref.name}'.`, `a declared zone: ${quoteList(zoneNames)}`,
        didYouMean(ref.name, zoneNames, zoneNames.length > 0 ? `Use one of ${quoteList(zoneNames)}.` : `Declare it: zone ${ref.name} { paths "..." }`), zoneNames)
    }
  }

  const budgetNames = ir.budgets.map((b) => b.name)
  const referencedBudgets = new Set(of("budget-ref").map((r) => r.name))
  for (const ref of of("budget-ref")) {
    if (!budgetNames.includes(ref.name)) {
      error("unknown-budget", ref.span, `Unknown budget '${ref.name}'.`, `a declared budget: ${quoteList(budgetNames)}`,
        didYouMean(ref.name, budgetNames, budgetNames.length > 0 ? `Use one of ${quoteList(budgetNames)}.` : `Declare it: budget ${ref.name} { command "..." }`),
        budgetNames)
    }
  }
  for (const budget of ir.budgets) {
    const span = spanOfNode(budget)!
    if (!referencedBudgets.has(budget.name)) {
      warning("unused-budget", span, `Budget '${budget.name}' is never checked by a gate.`, `\`budget ${budget.name}\` in a gate tier`,
        `Add it to a tier, for example: perf { budget ${budget.name} }, or remove the budget.`)
    }
    // Gauntlet reads only what the command writes to {json} (spec 0006).
    if (budget.command !== "" && !budget.command.includes("{json}")) {
      warning("budget-without-json", span, `Budget '${budget.name}''s command never mentions {json}, so Gauntlet has nothing to read.`, "a command that writes its measurements to {json}",
        "Write the results to {json}: your own JSON (p99, errors, throughput...), `hyperfine --export-json {json} ...` or `k6 run --summary-export {json} ...`.")
    }
  }

  const gateNames = [...checkNames.keys()]
  for (const ref of of("on-fail")) {
    if (!gateNames.includes(ref.gate)) {
      error("unknown-gate", ref.span, `\`on fail ${ref.gate}\` names a check that no gate tier runs.`, `a check from \`gates\`: ${quoteList(gateNames)}`,
        didYouMean(ref.gate, gateNames, gateNames.length > 0 ? `Use one of ${quoteList(gateNames)}.` : "Add the check to a gate tier first."), gateNames)
    }
  }

  // Predicates may use only predicates defined before them, which rules out cycles.
  const predicateOrder = ir.predicates.map((p) => p.name)
  const phrases = Object.keys(FACT_CONDITIONS)
  for (const ref of of("predicate-ref")) {
    const index = predicateOrder.indexOf(ref.name)
    if (index < 0) {
      const near = closest(ref.name, predicateOrder)
      error("unknown-predicate", ref.span, `'${ref.name}' is neither a predicate nor a condition.`,
        `a predicate (${quoteList(predicateOrder)}) or a condition such as ${quoteList(phrases.slice(0, 3))}`,
        near.length > 0 ? `Did you mean '${near[0]}'?` : `Define it first: predicate ${ref.name} = <condition>, or use one of ${quoteList(phrases)}.`,
        [...predicateOrder, ...phrases])
      continue
    }
    if (ref.from === undefined) continue
    if (ref.from === ref.name) {
      error("recursive-predicate", ref.span, `Predicate '${ref.name}' refers to itself.`, "conditions or earlier predicates", `Remove '${ref.name}' from its own definition.`)
    } else if (index > predicateOrder.indexOf(ref.from)) {
      error("predicate-order", ref.span, `Predicate '${ref.from}' uses '${ref.name}', which is defined later.`, "predicates defined before they are used",
        `Move \`predicate ${ref.name}\` above \`predicate ${ref.from}\`.`)
    }
  }

  // ---------- integrity ----------

  const implemented = new Set(used.flatMap((p) => p.integrity))
  for (const ref of of("integrity")) {
    if (!implemented.has(ref.id)) {
      error("integrity-not-implemented", ref.span, `No used pack implements the '${ref.phrase}' check, so it could never produce evidence.`,
        "an integrity check implemented by a used pack",
        used.length > 0 ? `Remove '${ref.phrase}', or use a pack that implements it.` : "Add `use <pack>` with a pack that implements it.")
    }
  }
  const missingDefaults = [...ir.integrity.ratchet, ...ir.integrity.forbid, ...ir.integrity.flag].filter((id) => !implemented.has(id))
  if (missingDefaults.length > 0) {
    info("integrity-not-executed", spans.integrity ?? spans.name,
      `These default integrity checks aren't implemented by any used pack and will be reported as not executed: ${quoteList(missingDefaults.map(phraseOf))}.`,
      "Nothing to fix in the policy. A pack that implements them removes the missing evidence.")
  }

  // ---------- top-level hints ----------

  if (spans.mode === undefined) {
    info("default-mode", spans.name, "No `mode` line, so the policy runs in shadow mode: it reports but never blocks.",
      "Add `mode enforce` when the shadow period is over.")
  }
  if (ir.owners.length === 0) {
    warning("no-policy-owners", spans.name, "Changes to `.gauntlet/` nominate owner, but the policy names no owners.", "an `owners` line",
      "Add a line such as: owners @platform")
  }
  if (spans.gates === undefined) {
    warning("no-gates", spans.name, "The policy has no `gates` block, so no evidence is collected and every change is missing evidence.",
      "a `gates` block", "Add gates, for example: gates { fast { build }, verify { unit } }")
  }
  if (ir.stack && spans.stack) {
    info("not-executed-in-v1", spans.stack, `The stack block describes stacked changes. ${NOT_EXECUTED}`,
      "Nothing to fix. Remove the block if changes should be able to reach auto or skim in v1.")
  }
}
