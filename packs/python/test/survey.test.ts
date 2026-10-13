import { describe, expect, test } from "bun:test"
import { pruneCandidates } from "@gauntlet/core"
import { pythonSurveyor } from "../src/detectors.ts"

// Spec 0016: how the Python pack reads a test file for `gauntlet prune tests`.

const FILE = `import pytest
from hypothesis import given, strategies as st


def expect_rate(a, b, rate):
    assert convert(a, b) == rate


def test_runs_without_checking():
    convert("GBP", "USD")


def test_cant_fail():
    assert True
    assert rate == rate


def test_gbp_to_usd():
    assert convert("GBP", "USD") == 1.25


# The same check again.
def test_pounds_to_dollars():
    assert convert( "GBP", "USD" ) == 1.25  # same


@pytest.mark.parametrize("n", [1, 2])
def test_positive(n):
    assert convert_n(n) > 0


@pytest.mark.parametrize("n", [3, 4])
def test_positive_again(n):
    assert convert_n(n) > 0


def test_via_helper():
    expect_rate("GBP", "EUR", 1.17)


@given(st.integers())
def test_round_trips(n):
    convert_n(n)


class TestLegacy:
    def test_gbp_to_usd(self):
        assert convert("GBP", "USD") == 1.25
`

describe("pythonSurveyor", () => {
  test("reads Python test files", () => {
    expect(pythonSurveyor.reads("tests/test_fx.py", false)).toBe(true)
    expect(pythonSurveyor.reads("fx/rates.py", false)).toBe(false)
    expect(pythonSurveyor.reads("tests/data.json", true)).toBe(false)
  })

  test("counts assertions, tautologies, helpers, property tests and classes", () => {
    const s = pythonSurveyor.survey("tests/test_fx.py", FILE)
    const by = Object.fromEntries(s.tests.map((t) => [t.name, t]))
    expect(by.test_runs_without_checking!.assertions).toBe(0)
    expect(by.test_cant_fail!.tautologies).toBe(2)
    expect(by.test_via_helper!.calls).toContain("expect_rate")
    expect(by.test_round_trips!.property).toBe(true)
    expect(by.test_positive!.line).toBe(27)
    expect(by["TestLegacy.test_gbp_to_usd"]!.scope).toBe("TestLegacy")
    expect(s.assertingHelpers).toEqual(["expect_rate"])
  })

  test("lists what tests nothing and what repeats another; different parameters aren't the same test", () => {
    const r = pruneCandidates([{ path: "tests/test_fx.py", survey: pythonSurveyor.survey("tests/test_fx.py", FILE) }])
    expect(r.testsNothing.map((c) => c.name)).toEqual(["test_runs_without_checking", "test_cant_fail"])
    expect(r.duplicates.map((d) => d.tests.map((t) => t.name))).toEqual([["test_gbp_to_usd", "test_pounds_to_dollars"]])
  })
})
