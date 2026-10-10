package {{package}}.domain

/** An ISO 4217 currency code, such as EUR. */
@JvmInline
value class Currency private constructor(val code: String) {
    companion object {
        private const val CODE_LENGTH = 3

        fun of(code: String): Currency? =
            if (code.length == CODE_LENGTH && code.all { it in 'A'..'Z' }) Currency(code) else null
    }
}

sealed interface MoneyError {
    data class CurrencyMismatch(val left: Currency, val right: Currency) : MoneyError

    data object Overflow : MoneyError
}

/** An amount in minor units (cents), so money never goes through floating point. */
data class Money(val minor: Long, val currency: Currency) {
    operator fun plus(other: Money): Outcome<MoneyError, Money> = when {
        currency != other.currency -> Outcome.Failure(MoneyError.CurrencyMismatch(currency, other.currency))
        overflows(minor, other.minor) -> Outcome.Failure(MoneyError.Overflow)
        else -> Outcome.Success(Money(minor + other.minor, currency))
    }

    operator fun unaryMinus(): Outcome<MoneyError, Money> =
        if (minor == Long.MIN_VALUE) Outcome.Failure(MoneyError.Overflow) else Outcome.Success(Money(-minor, currency))

    operator fun minus(other: Money): Outcome<MoneyError, Money> = (-other).flatMap { this + it }

    fun isPositive(): Boolean = minor > 0

    companion object {
        fun zero(currency: Currency): Money = Money(0, currency)

        /** Whether a + b leaves the Long range: both operands have the sign the sum lacks. */
        private fun overflows(a: Long, b: Long): Boolean {
            val sum = a + b
            return (a xor sum) and (b xor sum) < 0
        }
    }
}
