import httpx
import pytest

from app.llm_client import LlmCallError, call_rerank_llm


class FakeResponse:
    def __init__(self, json_body):
        self._json_body = json_body

    def raise_for_status(self):
        pass

    def json(self):
        return self._json_body


@pytest.mark.parametrize(
    "malformed_body",
    [
        [],
        {"message": None},
        {"message": []},
        "not even a dict",
    ],
)
def test_n4_p2_fix_malformed_response_shapes_raise_llm_call_error_not_type_error(
    monkeypatch, malformed_body
):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: FakeResponse(malformed_body))

    with pytest.raises(LlmCallError, match="missing expected message.content"):
        call_rerank_llm("task", [("agent-1", 0.9)])
