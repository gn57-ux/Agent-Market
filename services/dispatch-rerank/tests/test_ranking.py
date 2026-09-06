import pytest

from app.ranking import InvalidRankingError, validate_full_permutation, validate_reasons


def test_validate_full_permutation_accepts_a_real_permutation():
    validate_full_permutation(["a", "b", "c"], ["c", "a", "b"])


def test_validate_full_permutation_rejects_a_duplicate():
    with pytest.raises(InvalidRankingError, match="duplicate"):
        validate_full_permutation(["a", "b"], ["a", "a"])


def test_validate_full_permutation_rejects_an_out_of_bounds_id():
    with pytest.raises(InvalidRankingError, match="not in the input candidate set"):
        validate_full_permutation(["a", "b"], ["a", "b", "z"])


def test_validate_full_permutation_rejects_a_missing_candidate():
    with pytest.raises(InvalidRankingError, match="missing candidate"):
        validate_full_permutation(["a", "b", "c"], ["a", "b"])


def test_validate_reasons_accepts_a_complete_non_empty_reasons_dict():
    validate_reasons(["a", "b"], {"a": "reason a", "b": "reason b"})


def test_validate_reasons_rejects_a_missing_reason():
    with pytest.raises(InvalidRankingError, match="missing candidate"):
        validate_reasons(["a", "b"], {"a": "reason a"})


def test_validate_reasons_rejects_a_blank_reason():
    with pytest.raises(InvalidRankingError, match="empty/blank"):
        validate_reasons(["a", "b"], {"a": "reason a", "b": "   "})
