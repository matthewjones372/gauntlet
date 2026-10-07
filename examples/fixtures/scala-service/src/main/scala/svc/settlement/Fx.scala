package svc.settlement

import svc.domain.Money

object Fx:
  /** Converts with an integer rate in basis points, avoiding floating point. */
  def convert(amount: Money, rateBasisPoints: Long, target: String): Money =
    Money(amount.minor * rateBasisPoints / 10_000, target)
