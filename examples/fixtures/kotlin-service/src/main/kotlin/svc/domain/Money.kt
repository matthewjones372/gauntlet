package svc.domain

/** An amount in minor units (cents), so money never goes through floating point. */
data class Money(val minor: Long, val currency: String) {
    operator fun plus(other: Money): Money {
        require(currency == other.currency) { "currency mismatch: $currency vs ${other.currency}" }
        return Money(minor + other.minor, currency)
    }

    fun isPositive(): Boolean = minor > 0
}
