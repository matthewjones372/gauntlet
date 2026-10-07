package settlement

import (
	"testing"

	"example.com/svc/domain"
)

func TestConverts(t *testing.T) {
	if got := Convert(domain.Money{Minor: 100, Currency: "EUR"}, 11_000, "USD"); got != (domain.Money{Minor: 110, Currency: "USD"}) {
		t.Errorf("got %v", got)
	}
}
