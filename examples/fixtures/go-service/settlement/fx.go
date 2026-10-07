// Package settlement converts money between currencies.
package settlement

import "example.com/svc/domain"

// Convert converts with an integer rate in basis points, avoiding floating point.
func Convert(amount domain.Money, rateBasisPoints int64, target string) domain.Money {
	return domain.Money{Minor: amount.Minor * rateBasisPoints / 10_000, Currency: target}
}
