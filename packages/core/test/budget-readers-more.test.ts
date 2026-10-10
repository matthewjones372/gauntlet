import { describe, expect, test } from "bun:test"
import { parseBudgetResults } from "../src/budget.ts"

// Spec 0007, stage 1b: budgets read the benchmark and load-test tools people
// already use, as those tools write them. Times become milliseconds, failures
// a percentage, rates requests (or operations) a second.

describe("benchmarks", () => {
  test("JMH: each benchmark with its params a series; time modes in milliseconds, throughput a second", () => {
    const r = parseBudgetResults(JSON.stringify([
      { benchmark: "svc.FxBench.convert", mode: "sample", params: { size: "1000" }, primaryMetric: { score: 2500, scoreUnit: "ns/op", scorePercentiles: { "50.0": 2000, "90.0": 3000, "99.0": 9000, "100.0": 20000 } } },
      { benchmark: "svc.FxBench.parse", mode: "avgt", primaryMetric: { score: 1.5, scoreUnit: "us/op" } },
      { benchmark: "svc.FxBench.rate", mode: "thrpt", primaryMetric: { score: 12, scoreUnit: "ops/ms" } },
    ]))!
    expect(r.series["svc.FxBench.convert (size=1000)"]).toEqual({ mean: 0.0025, p50: 0.002, p90: 0.003, p99: 0.009, max: 0.02 })
    expect(r.series["svc.FxBench.parse"]).toEqual({ mean: 0.0015 })
    expect(r.series["svc.FxBench.rate"]).toEqual({ throughput: 12000 })
  })

  test("go test -bench, as text or -json: ns/op as each benchmark's mean", () => {
    const text = "goos: linux\nBenchmarkPrice-8   \t 1000000\t      1250 ns/op\t     64 B/op\nBenchmarkMatch-8   \t   20000\t     52000 ns/op\nPASS\n"
    expect(parseBudgetResults(text)!.series).toEqual({ BenchmarkPrice: { mean: 0.00125 }, BenchmarkMatch: { mean: 0.052 } })
    const json = text.split("\n").map((Output) => JSON.stringify({ Action: "output", Package: "svc", Output: `${Output}\n` })).join("\n")
    expect(parseBudgetResults(json)!.series).toEqual({ BenchmarkPrice: { mean: 0.00125 }, BenchmarkMatch: { mean: 0.052 } })
  })

  test("criterion's estimates.json: mean and median in milliseconds", () => {
    expect(parseBudgetResults(JSON.stringify({ mean: { point_estimate: 1_500_000 }, median: { point_estimate: 1_200_000 }, std_dev: { point_estimate: 10 } }))!.overall).toEqual({ mean: 1.5, p50: 1.2 })
  })

  test("pytest-benchmark: each benchmark a series, seconds to milliseconds", () => {
    const r = parseBudgetResults(JSON.stringify({ machine_info: {}, benchmarks: [{ name: "test_price", fullname: "tests/test_price.py::test_price", stats: { mean: 0.002, median: 0.0018, min: 0.001, max: 0.01, ops: 500 } }] }))!
    expect(r.overall).toEqual({ mean: 2, p50: 1.8, min: 1, max: 10, throughput: 500 })
  })
})

describe("load tests", () => {
  test("Locust's --csv stats: each request a series, the Aggregated row overall", () => {
    const csv = [
      "Type,Name,Request Count,Failure Count,Median Response Time,Average Response Time,Min Response Time,Max Response Time,Average Content Size,Requests/s,Failures/s,50%,66%,75%,80%,90%,95%,98%,99%,99.9%,99.99%,100%",
      "GET,/products,1000,0,12,15.5,3,200,512,50.0,0,12,14,16,18,25,40,60,90,150,190,200",
      'POST,"/orders, bulk",500,5,30,41,10,900,64,25.0,0.25,30,35,40,45,80,120,300,400,800,880,900',
      ",Aggregated,1500,5,15,24,3,900,363,75.0,0.25,15,20,25,30,50,90,200,350,700,850,900",
    ].join("\n")
    const r = parseBudgetResults(csv)!
    expect(r.overall).toMatchObject({ p50: 15, p99: 350, throughput: 75 })
    expect(r.overall.errors).toBeCloseTo(100 / 300, 9)
    expect(r.series["POST /orders, bulk"]).toMatchObject({ p99: 400, errors: 1, mean: 41 })
  })

  test("vegeta's JSON report: nanoseconds, success as errors", () => {
    const r = parseBudgetResults(JSON.stringify({ latencies: { mean: 5_000_000, "50th": 4_000_000, "90th": 8_000_000, "95th": 9_000_000, "99th": 20_000_000, max: 50_000_000, min: 1_000_000 }, requests: 3000, rate: 50, throughput: 49.5, success: 0.99, errors: [] }))!
    expect(r.overall).toEqual({ mean: 5, p50: 4, p90: 8, p95: 9, p99: 20, max: 50, min: 1, throughput: 49.5, errors: expect.closeTo(1, 9) })
  })

  test("oha --json: seconds, success as errors", () => {
    const r = parseBudgetResults(JSON.stringify({ summary: { successRate: 1, total: 10, slowest: 0.2, fastest: 0.001, average: 0.012, requestsPerSec: 800 }, latencyPercentiles: { p50: 0.01, p90: 0.02, p95: 0.03, p99: 0.08, "p99.9": 0.15 } }))!
    expect(r.overall).toEqual({ mean: 12, min: 1, max: 200, p50: 10, p90: 20, p95: 30, p99: 80, p999: 150, errors: 0, throughput: 800 })
  })

  test("something else entirely isn't mistaken for results", () => {
    expect(parseBudgetResults("all good\n")).toBeUndefined()
    expect(parseBudgetResults("[1, 2, 3]")).toBeUndefined()
  })
})
