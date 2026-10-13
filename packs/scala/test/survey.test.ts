import { describe, expect, test } from "bun:test"
import { pruneCandidates } from "@gauntlet/core"
import { scalaSurveyor } from "../src/detectors.ts"

// Spec 0016: how the Scala pack reads a test file for `gauntlet prune tests`.

const FILE = `package fx

class FxSuite extends munit.FunSuite {
  def expectRate(from: String, to: String, rate: Int): Unit = assertEquals(Fx.convert(100, from, to), rate)

  test("runs without checking") {
    Fx.convert(100, "GBP", "USD")
  }

  test("can't fail") {
    assert(true)
    assertEquals(rate, rate)
  }

  test("pounds to dollars") {
    assertEquals(Fx.convert(100, "GBP", "USD"), 125)
  }

  // The same check again.
  test("GBP to USD") {
    assertEquals(Fx.convert( 100, "GBP", "USD" ), 125) // same
  }

  test("via a helper") {
    expectRate("GBP", "EUR", 117)
  }

  property("round trips") {
    forAll { (n: Int) => Fx.convert(n, "GBP", "GBP") == n }
  }
}

class FxSpec extends AnyFlatSpec with Matchers {
  "convert" should "turn pounds into dollars" in {
    Fx.convert(100, "GBP", "USD") shouldBe 125
  }

  "convert" should "do it again" in {
    Fx.convert(100, "GBP", "USD") shouldBe 125
  }
}
`

describe("scalaSurveyor", () => {
  test("reads Scala test files", () => {
    expect(scalaSurveyor.reads("src/test/scala/FxSuite.scala", false)).toBe(true)
    expect(scalaSurveyor.reads("src/main/scala/Fx.scala", false)).toBe(false)
  })

  test("counts assertions, tautologies, helpers, property tests and classes", () => {
    const s = scalaSurveyor.survey("src/test/scala/FxSuite.scala", FILE)
    const by = Object.fromEntries(s.tests.map((t) => [t.name, t]))
    expect(by["FxSuite.runs without checking"]!.assertions).toBe(0)
    expect(by["FxSuite.can't fail"]!.tautologies).toBe(2)
    expect(by["FxSuite.via a helper"]!.calls).toContain("expectRate")
    expect(by["FxSuite.round trips"]!.property).toBe(true)
    expect(by["FxSpec.convert should turn pounds into dollars"]!.scope).toBe("FxSpec")
    expect(s.assertingHelpers).toEqual(["expectRate"])
  })

  test("lists what tests nothing and what repeats another, in both styles", () => {
    const r = pruneCandidates([{ path: "src/test/scala/FxSuite.scala", survey: scalaSurveyor.survey("src/test/scala/FxSuite.scala", FILE) }])
    expect(r.testsNothing.map((c) => c.name)).toEqual(["FxSuite.runs without checking", "FxSuite.can't fail"])
    expect(r.duplicates.map((d) => d.tests.map((t) => t.name))).toEqual([
      ["FxSuite.pounds to dollars", "FxSuite.GBP to USD"],
      ["FxSpec.convert should turn pounds into dollars", "FxSpec.convert should do it again"],
    ])
  })
})
