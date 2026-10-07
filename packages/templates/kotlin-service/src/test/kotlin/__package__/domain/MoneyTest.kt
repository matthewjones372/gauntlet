package {{package}}.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MoneyTest {
    private val eur = Currency.of("EUR")!!
    private val usd = Currency.of("USD")!!

    @Test
    fun currencyCodesAreThreeUppercaseLetters() {
        assertEquals("EUR", eur.code)
        assertNull(Currency.of("eur"))
        assertNull(Currency.of("EURO"))
        assertNull(Currency.of("EU"))
        assertNull(Currency.of("E1R"))
    }

    @Test
    fun adds() {
        assertEquals(Outcome.Success(Money(300, eur)), Money(100, eur) + Money(200, eur))
    }

    @Test
    fun subtracts() {
        assertEquals(Outcome.Success(Money(-100, eur)), Money(100, eur) - Money(200, eur))
    }

    @Test
    fun refusesMixedCurrencies() {
        assertEquals(Outcome.Failure(MoneyError.CurrencyMismatch(eur, usd)), Money(1, eur) + Money(1, usd))
        assertEquals(Outcome.Failure(MoneyError.CurrencyMismatch(eur, usd)), Money(1, eur) - Money(1, usd))
    }

    @Test
    fun reportsOverflowInsteadOfWrapping() {
        assertEquals(Outcome.Failure(MoneyError.Overflow), Money(Long.MAX_VALUE, eur) + Money(1, eur))
        assertEquals(Outcome.Failure(MoneyError.Overflow), Money(Long.MIN_VALUE, eur) + Money(-1, eur))
        assertEquals(Outcome.Failure(MoneyError.Overflow), -Money(Long.MIN_VALUE, eur))
        assertEquals(Outcome.Success(Money(Long.MAX_VALUE, eur)), Money(Long.MAX_VALUE - 1, eur) + Money(1, eur))
        assertEquals(Outcome.Success(Money(-1, eur)), Money(Long.MAX_VALUE, eur) + Money(Long.MIN_VALUE, eur))
    }

    @Test
    fun knowsWhenPositive() {
        assertTrue(Money(1, eur).isPositive())
        assertFalse(Money(0, eur).isPositive())
        assertFalse(Money(-1, eur).isPositive())
        assertEquals(Money(0, eur), Money.zero(eur))
    }
}
