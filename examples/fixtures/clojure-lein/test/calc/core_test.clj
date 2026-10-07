(ns calc.core-test
  (:require [clojure.test :refer [deftest is]]
            [calc.core :as calc]))

(deftest adds
  (is (= 3 (calc/add 1 2))))

(deftest adds-zero
  (is (= 1 (calc/add 1 0))))
