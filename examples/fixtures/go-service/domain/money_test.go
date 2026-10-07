package domain

import "testing"

func TestAdds(t *testing.T) {
	got, err := Add(Money{100, "EUR"}, Money{200, "EUR"})
	if err != nil || got != (Money{300, "EUR"}) {
		t.Errorf("got %v, %v", got, err)
	}
}

func TestRefusesMixedCurrencies(t *testing.T) {
	if _, err := Add(Money{1, "EUR"}, Money{1, "USD"}); err == nil {
		t.Error("expected a currency mismatch")
	}
}

func TestKnowsWhenPositive(t *testing.T) {
	if !IsPositive(Money{1, "EUR"}) {
		t.Error("1 is positive")
	}
	if IsPositive(Money{0, "EUR"}) {
		t.Error("0 isn't positive")
	}
}
