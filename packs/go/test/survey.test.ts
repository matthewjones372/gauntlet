import { describe, expect, test } from "bun:test"
import { pruneCandidates } from "@gauntlet/core"
import { goSurveyor } from "../src/detectors.ts"

// Spec 0016: how the Go pack reads a test file for `gauntlet prune tests`.

const FILE = `package fx

import "testing"

func TestNothing(t *testing.T) {
	Convert(1, 2)
}

func TestTautology(t *testing.T) {
	assert.Equal(t, 1, 1)
}

func TestA(t *testing.T) {
	if Convert(100, 9200) != 92 { t.Fatal("wrong") }
}

// The same check as TestA, laid out differently.
func TestB(t *testing.T) {
	if Convert(100, 9200) != 92 {
		t.Fatal("wrong") // é
	}
}

func TestOtherExample(t *testing.T) {
	if Convert(200, 9200) != 184 { t.Fatal("wrong") }
}

func TestViaHelper(t *testing.T) { check(t, 1) }

func check(t *testing.T, n int) {
	if n != 1 { t.Errorf("bad") }
}

func FuzzConvert(f *testing.F) { f.Fuzz(func(t *testing.T, n int64) { Convert(n, 1) }) }
`

describe("goSurveyor", () => {
  test("reads _test.go files only", () => {
    expect(goSurveyor.reads("fx/fx_test.go", false)).toBe(true)
    expect(goSurveyor.reads("fx/fx.go", true)).toBe(false)
  })

  test("counts assertions, tautologies, helpers and fuzz tests", () => {
    const s = goSurveyor.survey("fx/fx_test.go", FILE)
    const by = Object.fromEntries(s.tests.map((t) => [t.name, t]))
    expect(Object.keys(by)).toEqual(["TestNothing", "TestTautology", "TestA", "TestB", "TestOtherExample", "TestViaHelper", "FuzzConvert"])
    expect(by.TestNothing!.assertions).toBe(0)
    expect(by.TestNothing!.line).toBe(5)
    expect(by.TestTautology!.tautologies).toBe(1)
    expect(by.TestViaHelper!.calls).toContain("check")
    expect(by.FuzzConvert!.property).toBe(true)
    expect(s.assertingHelpers).toEqual(["check"])
  })

  test("lists what tests nothing and what repeats another", () => {
    const r = pruneCandidates([{ path: "fx/fx_test.go", survey: goSurveyor.survey("fx/fx_test.go", FILE) }])
    expect(r.testsNothing.map((c) => c.name)).toEqual(["TestNothing", "TestTautology"])
    expect(r.duplicates).toEqual([{ path: "fx/fx_test.go", tests: [{ name: "TestA", line: 13 }, { name: "TestB", line: 18 }] }])
  })
})
