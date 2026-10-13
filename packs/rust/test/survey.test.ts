import { describe, expect, test } from "bun:test"
import { pruneCandidates } from "@gauntlet/core"
import { rustSurveyor } from "../src/detectors.ts"

// Spec 0016: how the Rust pack reads test functions for `gauntlet prune tests`.

const FILE = `pub fn convert(minor: i64) -> i64 { minor }

#[cfg(test)]
mod tests {
    use super::*;

    fn expect_rate(n: i64, rate: i64) {
        assert_eq!(convert(n), rate);
    }

    #[test]
    fn runs_without_checking() {
        convert(1);
    }

    #[test]
    fn cant_fail() {
        assert!(true);
        assert_eq!(rate, rate);
    }

    #[test]
    fn hundred() {
        assert_eq!(convert(100), 100);
    }

    // The same check again.
    #[test]
    fn one_hundred() {
        assert_eq!(convert( 100 ), 100); // same
    }

    #[test_case(1)]
    #[test_case(2)]
    fn positive(n: i64) { assert!(convert(n) > 0); }

    #[test_case(3)]
    fn positive_again(n: i64) { assert!(convert(n) > 0); }

    #[test]
    fn via_helper() { expect_rate(1, 1); }

    #[quickcheck]
    fn round_trips(n: i64) -> bool { convert(n) == n }

    mod legacy {
        use super::*;
        #[test]
        fn hundred() {
            assert_eq!(convert(100), 100);
        }
    }
}
`

describe("rustSurveyor", () => {
  test("reads Rust files: tests live next to the code", () => {
    expect(rustSurveyor.reads("src/fx.rs", false)).toBe(true)
    expect(rustSurveyor.reads("Cargo.toml", false)).toBe(false)
  })

  test("counts assertions, tautologies, helpers, property tests and modules", () => {
    const s = rustSurveyor.survey("src/fx.rs", FILE)
    const by = Object.fromEntries(s.tests.map((t) => [t.name, t]))
    expect(by["tests::runs_without_checking"]!.assertions).toBe(0)
    expect(by["tests::cant_fail"]!.tautologies).toBe(2)
    expect(by["tests::via_helper"]!.calls).toContain("expect_rate")
    expect(by["tests::round_trips"]!.property).toBe(true)
    expect(by["tests::positive"]!.line).toBe(33)
    expect(by["tests::legacy::hundred"]!.scope).toBe("tests::legacy")
    expect(s.assertingHelpers).toEqual(["expect_rate"])
  })

  test("lists what tests nothing and what repeats another; different cases aren't the same test", () => {
    const r = pruneCandidates([{ path: "src/fx.rs", survey: rustSurveyor.survey("src/fx.rs", FILE) }])
    expect(r.testsNothing.map((c) => c.name)).toEqual(["tests::runs_without_checking", "tests::cant_fail"])
    expect(r.duplicates.map((d) => d.tests.map((t) => t.name))).toEqual([["tests::hundred", "tests::one_hundred"]])
  })
})
