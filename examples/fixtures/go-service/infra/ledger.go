// Package infra keeps the ledger.
package infra

import "example.com/svc/domain"

// Total sums the entries in one currency.
func Total(entries []domain.Money, currency string) domain.Money {
	result := domain.Money{Currency: currency}
	for _, e := range entries {
		if e.Currency == currency {
			if sum, err := domain.Add(result, e); err == nil {
				result = sum
			}
		}
	}
	return result
}

// HasEntries reports whether there are any entries.
func HasEntries(entries []domain.Money) bool {
	if len(entries) > 0 {
		return true
	}
	return false
}
