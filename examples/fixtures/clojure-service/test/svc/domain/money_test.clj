(ns svc.domain.money-test
  (:require [clojure.test :refer [deftest is]]
            [clojure.test.check.clojure-test :refer [defspec]]
            [clojure.test.check.generators :as gen]
            [clojure.test.check.properties :as prop]
            [svc.domain.money :as money]))

(deftest adds
  (is (= (money/money 5 "EUR") (money/add (money/money 2 "EUR") (money/money 3 "EUR")))))

(deftest refuses-mixed-currencies
  (is (= {:error :mixed-currencies} (money/add (money/money 2 "EUR") (money/money 3 "USD")))))

(deftest knows-when-positive
  (is (money/positive? (money/money 1 "EUR")))
  (is (not (money/positive? (money/money 0 "EUR")))))

(defspec adding-zero-changes-nothing 50
  (prop/for-all [n gen/large-integer]
    (= (money/money n "EUR") (money/add (money/money n "EUR") (money/money 0 "EUR")))))
