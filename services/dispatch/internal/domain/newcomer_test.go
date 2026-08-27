package domain

import "testing"

func TestIsNewcomer(t *testing.T) {
	cases := []struct {
		name               string
		completedTaskCount int
		want               bool
	}{
		{"zero completed tasks is a newcomer", 0, true},
		{"four completed tasks is a newcomer", 4, true},
		{"five completed tasks is not a newcomer", 5, false},
		{"ten completed tasks is not a newcomer", 10, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsNewcomer(tc.completedTaskCount)
			if got != tc.want {
				t.Fatalf("IsNewcomer(%d) = %v, want %v", tc.completedTaskCount, got, tc.want)
			}
		})
	}
}
