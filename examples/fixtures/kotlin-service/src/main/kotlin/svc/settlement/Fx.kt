package svc.settlement

import svc.domain.Money

/** Converts with an integer rate in basis points to avoid floating point. */
class Fx(private val rateBasisPoints: Long, private val target: String) {
    fun convert(amount: Money): Money = Money(amount.minor * rateBasisPoints / 10_000, target)
}
