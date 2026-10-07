package svc.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MoneyTest {
    @Test
    fun adds() {
        assertEquals(Money(300, "EUR"), Money(100, "EUR") + Money(200, "EUR"))
    }

    @Test
    fun refusesMixedCurrencies() {
        assertFailsWith<IllegalArgumentException> { Money(1, "EUR") + Money(1, "USD") }
    }

    @Test
    fun knowsWhenPositive() {
        assertTrue(Money(1, "EUR").isPositive())
        assertFalse(Money(0, "EUR").isPositive())
    }
}
