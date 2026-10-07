import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { DetectorInput } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseDependencies } from "../src/dependencies.ts"
import { pythonDetector } from "../src/detectors.ts"
import { parseLcov, parseMutmutMeta } from "../src/reports.ts"
import { runRules } from "../src/rules.ts"
import { enclosingSymbol, parsePython, stripLineComment } from "../src/syntax.ts"
import { isMainSource, isTestFile, manager, moduleName } from "../src/toolchain.ts"

const lines = (rule: string, text: string) => runRules([rule], [{ path: "a.py", text }]).map((r) => r.locations?.[0]?.physicalLocation?.region?.startLine)

describe("Python rules", () => {
  test("no-floating-money, no-global-mutation, no-raise", () => {
    expect(lines("py.no-floating-money", "def f(price: float, ratio: float, n: int = 1): ...\ntotal: float = 0.0\n")).toEqual([1, 2])
    expect(lines("py.no-global-mutation", "def f():\n    global x\n    nonlocal y\n")).toEqual([2, 3])
    expect(lines("py.no-raise", "def f():\n    raise ValueError()\n")).toEqual([2])
  })
  test("no-bare-except catches bare and catch-all excepts only", () => {
    expect(lines("py.no-bare-except", "try:\n    f()\nexcept:\n    pass\ntry:\n    f()\nexcept Exception as e:\n    pass\ntry:\n    f()\nexcept ValueError:\n    pass\n")).toEqual([3, 7])
  })
  test("no-mutable-defaults", () => {
    expect(lines("py.no-mutable-defaults", "def f(a=[], b={}, c=None, d=list(), e: dict = {}): ...\n")).toEqual([1, 1, 1, 1])
  })
})

const detect = (base: Record<string, string>, head: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-py-"))
  for (const [p, t] of Object.entries(head)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()
  const files = paths.flatMap((p) => base[p] === head[p] ? [] : [{ path: p, status: base[p] === undefined ? "added" as const : "modified" as const, added: 1, removed: 0 }])
  const addedLines = new Map(paths.map((p) => {
    const before = new Set((base[p] ?? "").split("\n"))
    return [p, (head[p] ?? "").split("\n").flatMap((text, i) => (before.has(text) ? [] : [{ line: i + 1, text }]))] as const
  }))
  const input: DetectorInput = {
    ir: undefined as never,
    facts: { base: "b", head: "h", files, linesChanged: 0, protectedTouched: [], zonesTouched: [], dependencyChanges: [], budgetsChanged: [], policyChanged: false, baselineChanged: false, gauntletChanged: false, addedLines },
    readBase: (p) => Effect.succeed(Option.fromNullishOr(base[p])),
    readHead: (p) => Effect.succeed(Option.fromNullishOr(head[p])),
    isTestPath: (p) => p.startsWith("tests/"),
    headFiles: Object.keys(head),
    dir,
  }
  return Effect.runPromise(pythonDetector.run(input).pipe(Effect.provide(BunServices.layer)))
}
const kinds = (out: Awaited<ReturnType<typeof detect>>) => out.findings.map((f) => `${f.kind} ${f.check}${f.line ? `@${f.line}` : ""}`)
const T = "tests/test_fx.py"
const M = "src/svc/fx.py"

describe("Python integrity detectors", () => {
  test("skips, tautologies, weakened, removed and empty new tests", async () => {
    const before = "def test_a():\n    assert f() == 1\n    assert g() == 2\n\ndef test_b():\n    assert h() == 3\n"
    const after = "import pytest\n\n@pytest.mark.skip\ndef test_a():\n    assert f() == 1\n    assert True\n\ndef test_c():\n    f()\n"
    expect(kinds(await detect({ [T]: before }, { [T]: after }))).toEqual([
      "forbid new-skips@3", "forbid deleted-tests", "forbid weakened-assertions@8", "forbid weakened-assertions@6",
    ])
  })
  test("sys.exit in a test and patching the module under test", async () => {
    const after = "import sys\nfrom unittest import mock\n\ndef test_a():\n    with mock.patch(\"svc.fx.rate\"):\n        assert f() == 1\n    sys.exit(0)\n"
    expect(kinds(await detect({ [T]: "def test_a():\n    assert f() == 1\n" }, { [T]: after })).sort()).toEqual(["flag mocks-of-class-under-test@5", "forbid exit-in-tests@7"])
  })
  test("main code: test imports, pytest sniffing, noqa, __eq__, catch-all, env branching", async () => {
    const after = [
      "import os",
      "from tests.helpers import fake",
      "class Fx:",
      "    def __eq__(self, other):",
      "        return True",
      "def run():",
      "    x = 1  # noqa: F841",
      "    try:",
      "        g()",
      "    except Exception:",
      "        pass",
      "    if os.getenv(\"FEATURE\"):",
      "        return 2",
      "    if \"PYTEST_CURRENT_TEST\" in os.environ:",
      "        return 3",
    ].join("\n")
    expect(kinds(await detect({ [M]: "import os\n" }, { [M]: after })).sort()).toEqual([
      "flag catch-all-near-changed-code@10", "flag env-branching@12", "flag env-branching@14", "flag equality-overrides@4",
      "forbid new-suppressions@7", "forbid test-refs-in-main@14", "forbid test-refs-in-main@2",
    ])
  })
  test("whole-project ratchets, with Hypothesis property tests", async () => {
    const head = {
      [T]: "from hypothesis import given\n\ndef test_a():\n    assert f() == 1\n    self.assertEqual(g(), 2)\n\n@pytest.mark.xfail\ndef test_b():\n    assert False\n\n@given(st.integers())\ndef test_p(n):\n    assert n == n\n",
      [M]: "x = 1  # type: ignore\n",
    }
    const out = await detect(head, head)
    expect(out.metrics["integrity/assertions-per-test"]?.value).toBe(4)
    expect(out.metrics["integrity/suppressions"]?.value).toBe(1)
    expect(out.metrics["integrity/quarantined-tests"]?.value).toBe(1)
    expect(out.metrics["integrity/property-tests"]?.value).toBe(1)
  })
})

describe("parsing and toolchain", () => {
  test("manager from the lockfile, test and main files, module names", () => {
    expect(manager(["uv.lock"])).toBe("uv")
    expect(manager(["poetry.lock"])).toBe("poetry")
    expect(manager(["requirements.txt"])).toBe("pip")
    expect(isTestFile("tests/test_fx.py")).toBe(true)
    expect(isTestFile("src/svc/fx_test.py")).toBe(true)
    expect(isMainSource("src/svc/fx.py")).toBe(true)
    expect(isMainSource(".venv/lib/x.py")).toBe(false)
    expect(moduleName("src/svc/domain/money.py")).toBe("svc.domain.money")
    expect(moduleName("svc/__init__.py")).toBe("svc")
  })
  test("mutmut meta files and lcov", () => {
    const meta = JSON.stringify({ exit_code_by_key: { "svc.fx.x_convert__mutmut_1": 1, "svc.fx.x_convert__mutmut_2": 0, "svc.fx.xǁRateǁapply__mutmut_1": 33, "svc.fx.x_f__mutmut_1": null } })
    expect(Option.getOrThrow(parseMutmutMeta("src/svc/fx.py", meta)).map((m) => `${m.function}:${m.outcome}`)).toEqual(["convert:killed", "convert:survived", "Rate.apply:no-tests", "f:other"])
    expect(parseLcov("SF:/repo/src/a.py\nDA:1,1\nDA:2,0\nend_of_record\n", "/repo").map((f) => [f.path, [...f.lines]])).toEqual([["src/a.py", [[1, true], [2, false]]]])
  })
  test("dependencies from pyproject and requirements", () => {
    const pyproject = `[project]\nname = "x"\ndependencies = ["httpx>=0.27", "attrs"]\n\n[dependency-groups]\ndev = [\n  "pytest==9.1.1", # tests\n  "ruff",\n]\n\n[tool.poetry.dependencies]\npython = "^3.13"\nrequests = "^2.32"\n`
    expect(parseDependencies("pyproject.toml", pyproject)).toEqual(["attrs", "httpx>=0.27", "pytest==9.1.1", "requests \"^2.32\"", "ruff"])
    expect(parseDependencies("requirements-dev.txt", "# dev\npytest==9\n-r requirements.txt\n\nruff\n")).toEqual(["pytest==9", "ruff"])
  })
  test("enclosing symbol and comment stripping", () => {
    expect(enclosingSymbol(parsePython("class Fx:\n    def convert(self):\n        return 1\n"), 3)).toBe("Fx.convert")
    expect(stripLineComment("x = '#not' # note")).toBe("x = '#not' ")
  })
})
