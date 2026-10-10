package {{package}}.app

import {{package}}.domain.Money
import {{package}}.domain.MoneyError
import {{package}}.domain.Outcome
import {{package}}.domain.flatMap
import {{package}}.domain.map
import {{package}}.domain.mapError

/** Where balances live. The application depends on this port; infrastructure implements it. */
interface Ledger {
    fun balance(account: String, like: Money): Money

    fun with(account: String, balance: Money): Ledger
}

sealed interface TransferError {
    data object NotPositive : TransferError

    data object SameAccount : TransferError

    data class InsufficientFunds(val account: String, val balance: Money) : TransferError

    data class Arithmetic(val error: MoneyError) : TransferError
}

private fun <A> Outcome<MoneyError, A>.arithmetic(): Outcome<TransferError, A> =
    mapError { TransferError.Arithmetic(it) }

/** Moves money between two accounts, returning the new ledger or why it can't. */
fun transfer(ledger: Ledger, from: String, to: String, amount: Money): Outcome<TransferError, Ledger> = when {
    !amount.isPositive() -> Outcome.Failure(TransferError.NotPositive)

    from == to -> Outcome.Failure(TransferError.SameAccount)

    else ->
        debit(ledger, from, amount).flatMap { left ->
            credit(ledger, to, amount).map { right -> ledger.with(from, left).with(to, right) }
        }
}

private fun debit(ledger: Ledger, account: String, amount: Money): Outcome<TransferError, Money> {
    val balance = ledger.balance(account, amount)
    return (balance - amount).arithmetic().flatMap { left ->
        if (left.minor < 0) {
            Outcome.Failure(TransferError.InsufficientFunds(account, balance))
        } else {
            Outcome.Success(left)
        }
    }
}

private fun credit(ledger: Ledger, account: String, amount: Money): Outcome<TransferError, Money> =
    (ledger.balance(account, amount) + amount).arithmetic()
