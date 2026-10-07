import { Effect, Layer, Ref } from "effect"
import { scriptPack } from "../../core/test/script-pack.ts"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { appLayer, ExitStatus, Output, runCli } from "../src/index.ts"

/** Runs the CLI in-process and captures what it prints. */
export const cli = async (args: string[], packs = [scriptPack]) => {
  const out: string[] = []
  const err: string[] = []
  const capture = Layer.succeed(Output, {
    out: (t) => Effect.sync(() => void out.push(t)),
    err: (t) => Effect.sync(() => void err.push(t)),
  })
  const code = await Effect.runPromise(runCli(args).pipe(Effect.provide(Layer.mergeAll(appLayer(packs), capture, ExitStatus.layer))))
  return { code, out: out.join("\n"), err: err.join("\n") }
}

export const POLICY = `gauntlet "svc"
use jvm
mode enforce
owners @platform
protect {
  tests  "src/test/**"
  config "scripts/**"
}
zone money { paths "src/money/**" owner @payments }
suites { unit "src/test/**" }
gates {
  fast   { build, lint ratchet }
  verify { unit, coverage >= 80% }
}
on fail coverage { fix "Add tests for the changed lines." }
predicate small = diff < 150 lines and no zone touched
review {
  owner  when zone touched
  review when protected changed
  auto   when small and all gates pass
}
`

// Each test in src/test/*Test.txt names a word; it passes unless
// src/main/behaviour.txt contains "broken <word>".
const TEST_SH = `#!/bin/sh
out="$1"
cases=""
for f in src/test/*Test.txt; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .txt)
  word=$(cat "$f")
  if grep -q "broken $word" src/main/behaviour.txt 2>/dev/null; then
    cases="$cases<testcase classname=\\"svc.$name\\" name=\\"$word\\"><failure message=\\"$word is broken\\"/></testcase>"
  else
    cases="$cases<testcase classname=\\"svc.$name\\" name=\\"$word\\"/>"
  fi
done
echo "<testsuite name=\\"unit\\">$cases</testsuite>" > "$out/TEST-unit.xml"
`

const EMPTY_SARIF = JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "lint-tool" } }, results: [] }] })

export const baseRepo = () => {
  const r = new TempRepo()
  r.write({
    ".gauntlet/policy.gx": POLICY,
    "scripts/build.sh": "exit 0\n",
    "scripts/lint.sh": `cp lint.sarif "$1/lint.sarif"\n`,
    "scripts/coverage.sh": `echo "{\\"value\\": $(cat coverage.txt)}" > "$1/coverage.json"\n`,
    "scripts/test.sh": TEST_SH,
    "lint.sarif": EMPTY_SARIF,
    "coverage.txt": "90\n",
    "src/main/behaviour.txt": "all good\n",
    "src/main/App.kt": "class App\n",
    "src/money/Fx.kt": "class Fx\n",
    "src/test/AddTest.txt": "add\n",
    "src/test/RoundTest.txt": "round\n",
  })
  const base = r.commit("base")
  r.git("checkout", "-q", "-b", "feature")
  return { r, base }
}
