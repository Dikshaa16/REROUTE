"""Talking with Rico out loud (Gemini Live): the server hands the app a short-lived pass with Rico's model, voice,
instructions and his one tool locked in; the Gemini key never leaves it."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import httpx
import pytest

from app.adapters import gemini_live
from app.config import get_settings
from app.services import roo_voice

from .conftest import key

NOW = datetime(2026, 10, 25, 3, 0, tzinfo=UTC)


def google(answer: httpx.Response, seen: list[httpx.Request]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def make_pass(answer: httpx.Response, seen: list[httpx.Request]) -> gemini_live.LivePass:
    return asyncio.run(
        gemini_live.create_pass("secret-key", "gemini-live-test", "Puck", "Be Rico.", [roo_voice.ASK_REROUTE], now=NOW, client=google(answer, seen))
    )


# ---------- the pass ----------


def test_the_pass_locks_rico_in_and_keeps_the_key_out_of_the_url():
    seen: list[httpx.Request] = []
    found = make_pass(httpx.Response(200, json={"name": "auth_tokens/one-use"}), seen)
    assert found == gemini_live.LivePass("auth_tokens/one-use", "gemini-live-test", datetime(2026, 10, 25, 3, 15, tzinfo=UTC))
    [request] = seen
    assert str(request.url) == gemini_live.TOKENS_URL and "secret-key" not in str(request.url)
    assert request.headers["x-goog-api-key"] == "secret-key"
    body = json.loads(request.content)
    # One session, started within a minute, at most 15 minutes long.
    assert body["uses"] == 1 and body["newSessionExpireTime"] == "2026-10-25T03:01:00Z" and body["expireTime"] == "2026-10-25T03:15:00Z"
    setup = body["bidiGenerateContentSetup"]
    assert setup["model"] == "models/gemini-live-test"
    assert setup["generationConfig"] == {"responseModalities": ["AUDIO"], "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Puck"}}}}
    assert setup["systemInstruction"] == {"parts": [{"text": "Be Rico."}]}
    # Both sides transcribed, for the captions; and Rico's one tool.
    assert setup["inputAudioTranscription"] == {} and setup["outputAudioTranscription"] == {}
    assert setup["tools"][0]["functionDeclarations"][0]["name"] == "ask_reroute"


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(400, json={"error": {"status": "INVALID_ARGUMENT"}}),
        httpx.Response(429),
        httpx.Response(200, json={"no": "name"}),
        httpx.Response(200, text="not json"),
    ],
)
def test_no_pass_when_google_refuses_or_answers_oddly(answer):
    with pytest.raises(gemini_live.LiveUnavailable):
        make_pass(answer, [])


def test_rico_knows_the_day_or_offers_to_start_one():
    assert roo_voice.instructions("Now: Wednesday in Bengaluru.").endswith("The traveller's day:\nNow: Wednesday in Bengaluru.")
    assert "has no trip yet" in roo_voice.instructions(None)
    # New in town: he's a guide too.
    assert "guide" in roo_voice.instructions(None, "tourist") and "guide glasses" not in roo_voice.instructions(None)


# ---------- the route ----------


@pytest.fixture
def voice_on(client, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ai_helper_enabled", True)
    monkeypatch.setattr(s, "gemini_api_key", "secret-key")
    asked: list[dict] = []

    async def fake_pass(api_key, model, voice, instructions, tools=None, now=None, client=None):
        asked.append({"key": api_key, "model": model, "voice": voice, "instructions": instructions, "tools": tools})
        return gemini_live.LivePass("auth_tokens/one-use", model, NOW)

    monkeypatch.setattr(gemini_live, "create_pass", fake_pass)
    return asked


def _live(client, **body):
    return client.post("/v1/roo/live", json={"idempotencyKey": key(), **body})


@pytest.mark.db
def test_off_without_the_ai_helper_or_a_key(client, monkeypatch):
    assert _live(client).status_code == 404
    assert client.get("/v1/me").json()["features"]["voiceChat"] is False
    monkeypatch.setattr(get_settings(), "ai_helper_enabled", True)
    assert _live(client).status_code == 404
    # The scripted fake model has no voice: still off.
    monkeypatch.setattr(get_settings(), "roo_fake_llm", "script.json")
    assert client.get("/v1/me").json()["features"]["voiceChat"] is False


@pytest.mark.db
def test_a_pass_for_the_day_on_screen(client, voice_on):
    assert client.get("/v1/me").json()["features"]["voiceChat"] is True
    res = _live(client, tripId="trip-001")
    assert res.status_code == 200, res.text
    out = res.json()
    assert out == {
        "token": "auth_tokens/one-use",
        "url": gemini_live.LIVE_URL,
        "model": get_settings().roo_live_model,
        "expiresAt": "2026-10-25T03:00:00Z",
        # Rico sounds like a child, like Ana: the app raises Google's grown-up voice.
        "pitch": 4.0,
    }
    [asked] = voice_on
    assert asked["voice"] == get_settings().roo_live_voice == "Achernar" and asked["tools"] == [roo_voice.ASK_REROUTE]
    # Rico hears about the actual trip, and nothing about being a guide.
    assert "Bengaluru" in asked["instructions"] and "Tasks:" in asked["instructions"] and "guide glasses" not in asked["instructions"]


@pytest.mark.db
def test_a_tourist_gets_a_guide_and_no_trip_is_fine(client, voice_on):
    assert _live(client, mode="tourist").status_code == 200
    assert "guide glasses" in voice_on[0]["instructions"] and "has no trip yet" in voice_on[0]["instructions"]
    assert _live(client, mode="spy").status_code == 422


@pytest.mark.db
def test_someone_elses_trip_is_not_found(client, voice_on):
    assert _live(client, tripId="trip-nope").status_code == 404
    assert voice_on == []


@pytest.mark.db
def test_google_saying_no_is_a_gentle_503(client, voice_on, monkeypatch):
    async def refused(*args, **kwargs):
        raise gemini_live.LiveUnavailable

    monkeypatch.setattr(gemini_live, "create_pass", refused)
    res = _live(client)
    assert res.status_code == 503 and res.json()["error"]["code"] == "UNAVAILABLE"


@pytest.mark.db
def test_a_voice_session_counts_against_ricos_limits(client, voice_on, monkeypatch):
    monkeypatch.setattr(get_settings(), "roo_agent_per_minute", 2)
    assert [_live(client).status_code for _ in range(3)] == [200, 200, 429]
