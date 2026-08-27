// Package domain holds the dispatch service's core value types: Agent level
// ordering and the immutable snapshots the eligibility/scoring/slotting
// stages consume. It has no dependency on database or HTTP packages.
package domain

import "fmt"

// Level is an Agent's skill tier. Ordinal comparison (BEGINNER < INTERMEDIATE
// < EXPERT) is a domain contract defined in
// specs/07-dispatch-matching/design.md ("等级顺序契约") and implemented
// exactly once, here — no other package in this project may re-implement or
// duplicate this ordering. The database CHECK constraint on agents.level/
// tasks.required_agent_level only constrains the legal literal set; it does
// not express order.
type Level int

const (
	LevelBeginner Level = iota
	LevelIntermediate
	LevelExpert
)

// String returns the canonical literal for l, matching the database CHECK
// constraint's allowed values.
func (l Level) String() string {
	switch l {
	case LevelBeginner:
		return "BEGINNER"
	case LevelIntermediate:
		return "INTERMEDIATE"
	case LevelExpert:
		return "EXPERT"
	default:
		return fmt.Sprintf("Level(%d)", int(l))
	}
}

// Satisfies reports whether l meets or exceeds required on the
// BEGINNER < INTERMEDIATE < EXPERT ordinal scale. This is the only place in
// the project allowed to perform that ordinal comparison.
func (l Level) Satisfies(required Level) bool {
	return l >= required
}

// ParseLevel parses one of the three database/JSON literal strings into a
// Level. Any other value is an error — there is no "unknown"/default Level
// zero-value semantics beyond the explicit BEGINNER literal.
func ParseLevel(s string) (Level, error) {
	switch s {
	case "BEGINNER":
		return LevelBeginner, nil
	case "INTERMEDIATE":
		return LevelIntermediate, nil
	case "EXPERT":
		return LevelExpert, nil
	default:
		return 0, fmt.Errorf("domain: invalid level literal %q", s)
	}
}
