// Mutation testing in plain words, wherever people meet it: setup, the report
// and a slow run. Someone who has never heard of it should know what it is,
// why it takes longer than their tests, and how to keep it quick.

export const MUTATION_WHAT =
  "Mutation testing makes small deliberate bugs in your code (turning a `>` into `>=`, say) and runs your tests against each one. A bug that no test catches shows a test that runs the code but doesn't really check it."

export const MUTATION_COST =
  "It runs your tests once for every bug it makes, so it's by far the slowest check: minutes where your tests take seconds, and far longer across a whole project."

export const MUTATION_FASTER =
  "To keep it quick, run it only on the lines a change touches (`mutation >= 60% on changed`), only in the zones that matter (`... on changed in zone money`), or leave it out of the policy."

/** A mutation run that took this long gets a note on why, and how to speed it up. */
export const SLOW_MUTATION_MS = 3 * 60_000

/** Whether a policy runs mutation testing. */
export const runsMutation = (ir: { readonly gates: ReadonlyArray<{ readonly checks: ReadonlyArray<{ readonly kind: string; readonly name?: string }> }> }) =>
  ir.gates.some((g) => g.checks.some((c) => c.kind === "gate" && c.name === "mutation"))
