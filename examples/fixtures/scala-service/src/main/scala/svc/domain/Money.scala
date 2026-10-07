package svc.domain

/** An amount in minor units (cents), so money never goes through floating point. */
final case class Money(minor: Long, currency: String)

object Money:
  def add(a: Money, b: Money): Either[String, Money] =
    if a.currency != b.currency then Left(s"currency mismatch: ${a.currency} vs ${b.currency}")
    else Right(Money(a.minor + b.minor, a.currency))

  def isPositive(m: Money): Boolean = m.minor > 0
