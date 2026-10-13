import { describe, expect, test } from "bun:test"
import { pruneCandidates } from "@gauntlet/core"
import { kotlinSurveyor } from "../src/kotlin/detectors.ts"

// Spec 0016: how the JVM pack reads a Kotlin test file for `gauntlet prune tests`.

const FILE = `package fx

import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

class FxTest {
    @Test
    fun runsWithoutChecking() {
        Fx.convert(100, "GBP", "USD")
    }

    @Test
    fun cantFail() {
        assertTrue(true)
    }

    @Test
    fun poundsToDollars() {
        assertEquals(125, Fx.convert(100, "GBP", "USD"))
    }

    /** The same check again. */
    @Test
    fun gbpToUsd() {
        assertEquals(125,
            Fx.convert(100, "GBP", "USD")) // same
    }

    @ParameterizedTest
    @ValueSource(ints = [1, 2])
    fun positive(n: Int) { assertTrue(Fx.convert(n, "GBP", "USD") > 0) }

    @ParameterizedTest
    @ValueSource(ints = [3, 4])
    fun positiveAgain(n: Int) { assertTrue(Fx.convert(n, "GBP", "USD") > 0) }

    @Test
    fun viaHelper() { expectRate("GBP", "EUR", 117) }

    @Test
    fun roundTrips() = runTest { checkAll(Arb.int()) { n -> Fx.convert(n, "GBP", "GBP") } }

    private fun expectRate(from: String, to: String, rate: Int) = assertEquals(rate, Fx.convert(100, from, to))
}

class OtherTest {
    @Test
    fun poundsToDollars() {
        assertEquals(125, Fx.convert(100, "GBP", "USD"))
    }
}
`

describe("kotlinSurveyor", () => {
  test("reads Kotlin files the policy counts as tests", () => {
    expect(kotlinSurveyor.reads("src/test/kotlin/FxTest.kt", true)).toBe(true)
    expect(kotlinSurveyor.reads("src/main/kotlin/Fx.kt", false)).toBe(false)
    expect(kotlinSurveyor.reads("src/test/resources/fx.json", true)).toBe(false)
  })

  test("counts assertions, tautologies, helpers, property tests and classes", () => {
    const s = kotlinSurveyor.survey("src/test/kotlin/FxTest.kt", FILE)
    const by = Object.fromEntries(s.tests.map((t) => [`${t.scope}.${t.name}`, t]))
    expect(by["FxTest.runsWithoutChecking"]!.assertions).toBe(0)
    expect(by["FxTest.cantFail"]!.tautologies).toBe(1)
    expect(by["FxTest.viaHelper"]!.calls).toContain("expectRate")
    expect(by["FxTest.roundTrips"]!.property).toBe(true)
    expect(by["OtherTest.poundsToDollars"]).toBeDefined()
    expect(s.assertingHelpers).toEqual(["expectRate"])
  })

  test("lists what tests nothing and what repeats another; different parameters aren't the same test", () => {
    const r = pruneCandidates([{ path: "src/test/kotlin/FxTest.kt", survey: kotlinSurveyor.survey("src/test/kotlin/FxTest.kt", FILE) }])
    expect(r.testsNothing.map((c) => c.name)).toEqual(["runsWithoutChecking", "cantFail"])
    expect(r.duplicates.map((d) => d.tests.map((t) => t.name))).toEqual([["poundsToDollars", "gbpToUsd"]])
  })
})
