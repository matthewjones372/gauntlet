import { convertJUnit } from "@gauntlet/sarif"
import { Effect } from "effect"
import type { Pack, SuiteImpl } from "../src/index.ts"
import { ProcessRunner } from "../src/index.ts"
import { scriptPack } from "./script-pack.ts"

// The script pack, with a suite runner that honours subsets and seeds (M15).
// Its test script (FLAKY_TEST_SH) decides each test from its file: the first
// line is the test's word, the second an optional mode:
//   coin     fails when the seed is odd (a test that depends on order)
//   nervous  fails without a seed, passes on any rerun (an old flaky test)
// and any test fails while src/main/behaviour.txt says "broken <word>".

export const FLAKY_TEST_SH = `#!/bin/sh
out="$1"; shift; shift
files="$*"
[ -n "$files" ] || files=$(ls src/test/*Test.txt 2>/dev/null)
cases=""
for f in $files; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .txt)
  word=$(sed -n 1p "$f")
  mode=$(sed -n 2p "$f")
  fail=""
  grep -q "broken $word" src/main/behaviour.txt 2>/dev/null && fail=1
  case "$mode" in
    coin) [ -n "$SEED" ] && [ $((SEED % 2)) -eq 1 ] && fail=1 ;;
    nervous) [ -z "$SEED" ] && fail=1 ;;
  esac
  if [ -n "$fail" ]; then
    cases="$cases<testcase classname=\\"svc.$name\\" name=\\"$word\\" file=\\"$f\\"><failure message=\\"$word is broken\\"/></testcase>"
  else
    cases="$cases<testcase classname=\\"svc.$name\\" name=\\"$word\\" file=\\"$f\\"/>"
  fi
done
echo "<testsuite name=\\"unit\\">$cases</testsuite>" > "$out/TEST-unit.xml"
`

const suite: SuiteImpl = (s, ctx, subset) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const args = ["scripts/test.sh", ctx.outputDir, s.location, ...(subset?.files ?? [])]
    const result = yield* Effect.exit(runner.run({ command: "sh", args, cwd: ctx.dir, env: subset ? { SEED: String(subset.seed) } : {}, timeout: "30 seconds" }))
    const exitCode = result._tag === "Success" ? result.value.exitCode : -1
    const files = (yield* ctx.collect).filter((f) => f.path.endsWith(".xml"))
    if (files.length === 0) return { command: ["sh", ...args], exitCode, runs: [] }
    const report = yield* Effect.exit(convertJUnit(s.name, files))
    if (report._tag === "Failure") return { command: ["sh", ...args], exitCode, runs: [], error: "the test report isn't valid JUnit XML" }
    return { command: ["sh", ...args], exitCode, runs: [report.value.run], tests: { counts: report.value.counts, ids: report.value.tests.map((t) => t.id) } }
  })

export const flakyPack: Pack = { ...scriptPack, runSuite: suite, reruns: true }
