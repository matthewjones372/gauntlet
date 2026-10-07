(ns svc.infra.ledger
  (:require [svc.domain.money :as money]))

(defn total [entries]
  (let [unused 0]
    (reduce money/add (money/money 0 "EUR") entries)))
