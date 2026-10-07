(ns svc.settlement.fx-test
  (:require [clojure.test :refer [deftest is]]
            [svc.domain.money :as money]
            [svc.settlement.fx :as fx]))

(deftest converts
  (is (= (money/money 92 "USD") (fx/convert (money/money 100 "EUR") 9200 "USD"))))
