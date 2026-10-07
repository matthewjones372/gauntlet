(ns svc.domain.money)

(defn money [minor currency]
  {:minor minor :currency currency})

(defn add [a b]
  (if (= (:currency a) (:currency b))
    (money (+ (:minor a) (:minor b)) (:currency a))
    {:error :mixed-currencies}))

(defn positive? [m]
  (pos? (:minor m)))
