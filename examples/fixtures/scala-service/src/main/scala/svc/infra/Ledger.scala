package svc.infra

import svc.domain.Money

object Ledger:
  /** Sums the entries in one currency. */
  def total(entries: List[Money], currency: String): Money =
    var result = Money(0, currency)
    entries.filter(_.currency == currency).foreach { e =>
      Money.add(result, e).foreach(sum => result = sum)
    }
    result
