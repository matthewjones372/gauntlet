package svc.settlement

import kotlin.test.Test
import kotlin.test.assertEquals
import svc.domain.Money

class FxTest {
    @Test
    fun converts() {
        assertEquals(Money(110, "USD"), Fx(11_000, "USD").convert(Money(100, "EUR")))
    }
}
