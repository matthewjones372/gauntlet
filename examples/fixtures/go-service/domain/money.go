// Package domain holds the values and rules of the service.
package domain

import "fmt"

// Money is an amount in minor units (cents), so money never goes through floating point.
type Money struct {
	Minor    int64
	Currency string
}

// Add adds two amounts in the same currency.
func Add(a, b Money) (Money, error) {
	if a.Currency != b.Currency {
		return Money{}, fmt.Errorf("currency mismatch: %s vs %s", a.Currency, b.Currency)
	}
	return Money{Minor: a.Minor + b.Minor, Currency: a.Currency}, nil
}

// IsPositive reports whether the amount is above zero.
func IsPositive(m Money) bool { return m.Minor > 0 }
