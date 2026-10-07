import { describe, expect, test } from "bun:test"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { runSuite } from "../src/gates.ts"

describe("Python reruns", () => {
  test("test ids map to their modules' files, string hashing is seeded, and pytest-randomly is used when declared", async () => {
    const g = fakeGate({
      "uv.lock": "", ".venv/bin/pytest": "",
      "pyproject.toml": "[dependency-groups]\ndev = [\"pytest\", \"pytest-randomly>=3\"]\n",
      "tests/test_fx.py": "", "tests/test_money.py": "",
    })
    await g.run(runSuite({ name: "unit", location: "tests/**" }, g.ctx, { files: [], ids: ["tests.test_fx.test_converts"], seed: 9 }))
    const call = g.calls.at(-1)!
    expect(call.args).toEqual(expect.arrayContaining(["-p", "randomly", "--randomly-seed=9", "tests/test_fx.py"]))
    expect(call.args).not.toContain("tests/test_money.py")
    expect(call.env?.PYTHONHASHSEED).toBe("9")
  })

  test("without pytest-randomly only the hash seed varies", async () => {
    const g = fakeGate({ "uv.lock": "", ".venv/bin/pytest": "", "pyproject.toml": "[dependency-groups]\ndev = [\"pytest\"]\n", "tests/test_fx.py": "" })
    await g.run(runSuite({ name: "unit", location: "tests/**" }, g.ctx, { files: ["tests/test_fx.py"], ids: [], seed: 3 }))
    expect(g.calls.at(-1)!.args).not.toContain("randomly")
    expect(g.calls.at(-1)!.env?.PYTHONHASHSEED).toBe("3")
  })
})
