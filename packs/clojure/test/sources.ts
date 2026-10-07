// Copies of the Clojure fixtures the unit tests read, kept inline so the tests
// pass in a judged checkout, where fixtures a change adds are removed. The
// end-to-end test runs the fixtures themselves.

export const SOURCES: Record<string, string> = {
  "clojure-service/deps.edn": "{:paths [\"src\"]\n :deps {org.clojure/clojure {:mvn/version \"1.12.6\"}}\n :aliases {:test {:extra-paths [\"test\"]\n                  :extra-deps {org.clojure/test.check {:mvn/version \"1.1.3\"}}}}}\n",
  "clojure-service/src/svc/domain/money.clj": "(ns svc.domain.money)\n\n(defn money [minor currency]\n  {:minor minor :currency currency})\n\n(defn add [a b]\n  (if (= (:currency a) (:currency b))\n    (money (+ (:minor a) (:minor b)) (:currency a))\n    {:error :mixed-currencies}))\n\n(defn positive? [m]\n  (pos? (:minor m)))\n",
  "clojure-service/src/svc/settlement/fx.clj": "(ns svc.settlement.fx\n  (:require [svc.domain.money :as money]))\n\n(defn convert\n  \"Converts at a rate in basis points: 9200 is 0.92.\"\n  [m rate-bp currency]\n  (money/money (quot (* (:minor m) rate-bp) 10000) currency))\n",
  "clojure-service/src/svc/infra/ledger.clj": "(ns svc.infra.ledger\n  (:require [svc.domain.money :as money]))\n\n(defn total [entries]\n  (let [unused 0]\n    (reduce money/add (money/money 0 \"EUR\") entries)))\n",
  "clojure-service/test/svc/domain/money_test.clj": "(ns svc.domain.money-test\n  (:require [clojure.test :refer [deftest is]]\n            [clojure.test.check.clojure-test :refer [defspec]]\n            [clojure.test.check.generators :as gen]\n            [clojure.test.check.properties :as prop]\n            [svc.domain.money :as money]))\n\n(deftest adds\n  (is (= (money/money 5 \"EUR\") (money/add (money/money 2 \"EUR\") (money/money 3 \"EUR\")))))\n\n(deftest refuses-mixed-currencies\n  (is (= {:error :mixed-currencies} (money/add (money/money 2 \"EUR\") (money/money 3 \"USD\")))))\n\n(deftest knows-when-positive\n  (is (money/positive? (money/money 1 \"EUR\")))\n  (is (not (money/positive? (money/money 0 \"EUR\")))))\n\n(defspec adding-zero-changes-nothing 50\n  (prop/for-all [n gen/large-integer]\n    (= (money/money n \"EUR\") (money/add (money/money n \"EUR\") (money/money 0 \"EUR\")))))\n",
  "clojure-service/test/svc/settlement/fx_test.clj": "(ns svc.settlement.fx-test\n  (:require [clojure.test :refer [deftest is]]\n            [svc.domain.money :as money]\n            [svc.settlement.fx :as fx]))\n\n(deftest converts\n  (is (= (money/money 92 \"USD\") (fx/convert (money/money 100 \"EUR\") 9200 \"USD\"))))\n",
  "clojure-service/tests.edn": "#kaocha/v1 {}\n",
  "clojure-service/.clj-kondo/config.edn": "{:linters {:unused-binding {:level :warning}}}\n",
  "clojure-lein/project.clj": "(defproject calc \"0.1.0\"\n  :dependencies [[org.clojure/clojure \"1.12.6\"]])\n",
  "clojure-lein/src/calc/core.clj": "(ns calc.core)\n\n(defn add [a b]\n  (+ a b))\n",
  "clojure-lein/test/calc/core_test.clj": "(ns calc.core-test\n  (:require [clojure.test :refer [deftest is]]\n            [calc.core :as calc]))\n\n(deftest adds\n  (is (= 3 (calc/add 1 2))))\n\n(deftest adds-zero\n  (is (= 1 (calc/add 1 0))))\n",
}

export const fixture = (p: string) => {
  const text = SOURCES[p]
  if (text === undefined) throw new Error(`no inline copy of ${p}`)
  return text
}

/** The files of one fixture, keyed by their path inside it. */
export const project = (name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(SOURCES).filter(([p]) => p.startsWith(`${name}/`)).map(([p, t]) => [p.slice(name.length + 1), t]))
