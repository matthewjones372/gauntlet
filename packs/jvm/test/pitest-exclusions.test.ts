import { describe, expect, test } from "bun:test"
import { pitestExclusions } from "../src/sources.ts"

// Spec 0011 §4: with `on changed`, code the compiler generated is skipped by
// name. Untouched methods are left to Gauntlet's line filter (spec 0019).

const ACCOUNT = `package bank

data class Balance(val id: String, val owner: String)

class Account(private val limit: Long) {
    val left: Long
        get() = limit - spent

    var spent: Long = 0
        set(v) {
            field = v
        }

    fun withdraw(amount: Long): Boolean {
        if (amount > left) return false
        spent += amount
        return true
    }

    fun deposit(amount: Long) {
        spent -= amount
    }
}

fun opening(limit: Long) = Account(limit)
`

const at = (...lines: number[]) => new Map([["src/main/kotlin/bank/Account.kt", new Set(lines)]])
const files = [{ path: "src/main/kotlin/bank/Account.kt", text: ACCOUNT }]

describe("Pitest exclusions", () => {
  // Spec 0019 §2: the others are skipped by Gauntlet's Pitest filter, which drops their mutants by line, not by name here.
  test("a change inside one function keeps that function and skips the others", () => {
    const skipped = pitestExclusions(files, at(15))
    expect(skipped).not.toContain("withdraw")
    expect(skipped).not.toContain("deposit")
    expect(skipped).not.toContain("opening")
  })

  test("a changed custom getter or setter is kept under its JVM name", () => {
    expect(pitestExclusions(files, at(7))).not.toContain("getLeft")
    expect(pitestExclusions(files, at(11))).not.toContain("setSpent")
    expect(pitestExclusions(files, at(15))).toEqual(expect.arrayContaining(["getLeft", "setSpent", "getSpent"]))
  })

  test("generated data-class methods and plain property accessors are always skipped", () => {
    expect(pitestExclusions(files, at(15))).toEqual(expect.arrayContaining(["component*", "copy", "copy$default", "equals", "hashCode", "toString", "getId", "getOwner"]))
  })

  test("a declared equals the change touches is kept", () => {
    const text = `package a\n\nclass Fx {\n    override fun equals(other: Any?): Boolean {\n        return other is Fx\n    }\n}\n`
    expect(pitestExclusions([{ path: "src/main/kotlin/a/Fx.kt", text }], new Map([["src/main/kotlin/a/Fx.kt", new Set([5])]]))).not.toContain("equals")
  })

  test("a name touched in one changed file isn't skipped because another file doesn't touch it", () => {
    const other = { path: "src/main/kotlin/bank/Ledger.kt", text: "package bank\n\nclass Ledger {\n    fun withdraw() = 1\n}\n" }
    expect(pitestExclusions([...files, other], at(15))).not.toContain("withdraw")
  })

  test("with a changed Java file nothing is skipped, since its methods aren't read", () => {
    const java = { path: "src/main/java/bank/Fx.java", text: "package bank;\nclass Fx { int rate() { return 1; } }\n" }
    expect(pitestExclusions([...files, java], at(15))).toEqual([])
  })
})
