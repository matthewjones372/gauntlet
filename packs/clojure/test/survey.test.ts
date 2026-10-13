import { describe, expect, test } from "bun:test"
import { pruneCandidates } from "@gauntlet/core"
import { clojureSurveyor } from "../src/detectors.ts"

// Spec 0016: how the Clojure pack reads a test namespace for `gauntlet prune tests`.

const FILE = `(ns fx.core-test
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.test.check.clojure-test :refer [defspec]]
            [fx.core :as fx]))

(defn expect-rate [from to rate]
  (is (= rate (fx/convert 100 from to))))

(deftest runs-without-checking
  (fx/convert 100 :gbp :usd))

(deftest cant-fail
  (is true)
  (is (= rate rate)))

(deftest pounds-to-dollars
  (is (= 125 (fx/convert 100 :gbp :usd))))

(deftest gbp-to-usd
  (is (= 125
         (fx/convert 100 :gbp :usd))))

(deftest via-helper
  (expect-rate :gbp :eur 117))

(defspec round-trips 100
  (prop/for-all [n gen/int] (= n (fx/convert n :gbp :gbp))))
`

describe("clojureSurveyor", () => {
  test("reads Clojure test namespaces", () => {
    expect(clojureSurveyor.reads("test/fx/core_test.clj", false)).toBe(true)
    expect(clojureSurveyor.reads("src/fx/core.clj", false)).toBe(false)
  })

  test("counts assertions, tautologies, helpers and property tests", () => {
    const s = clojureSurveyor.survey("test/fx/core_test.clj", FILE)
    const by = Object.fromEntries(s.tests.map((t) => [t.name, t]))
    expect(by["fx.core-test.runs-without-checking"]!.assertions).toBe(0)
    expect(by["fx.core-test.runs-without-checking"]!.line).toBe(9)
    expect(by["fx.core-test.cant-fail"]!.tautologies).toBe(2)
    expect(by["fx.core-test.via-helper"]!.calls).toContain("expect-rate")
    expect(by["fx.core-test.round-trips"]!.property).toBe(true)
    expect(s.assertingHelpers).toEqual(["expect-rate"])
  })

  test("lists what tests nothing and what repeats another", () => {
    const r = pruneCandidates([{ path: "test/fx/core_test.clj", survey: clojureSurveyor.survey("test/fx/core_test.clj", FILE) }])
    expect(r.testsNothing.map((c) => c.name)).toEqual(["fx.core-test.runs-without-checking", "fx.core-test.cant-fail"])
    expect(r.duplicates.map((d) => d.tests.map((t) => t.name))).toEqual([["fx.core-test.pounds-to-dollars", "fx.core-test.gbp-to-usd"]])
  })
})
