(ns svc.settlement.fx
  (:require [svc.domain.money :as money]))

(defn convert
  "Converts at a rate in basis points: 9200 is 0.92."
  [m rate-bp currency]
  (money/money (quot (* (:minor m) rate-bp) 10000) currency))
