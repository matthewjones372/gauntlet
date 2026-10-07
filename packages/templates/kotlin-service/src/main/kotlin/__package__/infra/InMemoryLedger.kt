package {{package}}.infra

import {{package}}.app.Ledger
import {{package}}.domain.Money

/** An immutable ledger: every change returns a new one. */
data class InMemoryLedger(private val balances: Map<Pair<String, String>, Money> = emptyMap()) : Ledger {
    override fun balance(account: String, like: Money): Money =
        balances[account to like.currency.code] ?: Money.zero(like.currency)

    override fun with(account: String, balance: Money): Ledger =
        InMemoryLedger(balances + ((account to balance.currency.code) to balance))
}
