import { describe, expect, test } from "bun:test"
import { parseMutations } from "../src/reports.ts"

// Spec 0012: the scenarios report shows what a killed mutant changed, in Pitest's words.

describe("Pitest's description of a mutant", () => {
  test("is read with the mutant", () => {
    const xml = `<mutations><mutation detected="true" status="KILLED"><sourceFile>Fx.kt</sourceFile><mutatedClass>svc.Fx</mutatedClass><mutatedMethod>convert</mutatedMethod><lineNumber>7</lineNumber><mutator>MathMutator</mutator><description>Replaced long division with multiplication</description></mutation></mutations>`
    expect(parseMutations(xml)[0]!.description).toBe("Replaced long division with multiplication")
    expect(parseMutations(xml.replace(/<description>.*<\/description>/, ""))[0]).not.toHaveProperty("description")
  })
})
