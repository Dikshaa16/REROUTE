"""Gemini Live: talking with Rico out loud, in real time.

The app streams the traveller's voice to Google and plays Rico's back as it comes, and Google's voice activity
detection hears when the traveller starts and stops (and lets them cut in). The API key never leaves the server:
it asks Google for a short-lived pass that can start one session within a minute, with Rico's model, voice and
instructions locked into it, and hands only that to the app.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

log = logging.getLogger("reroute.live")

TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens"
#: Where the app connects with the pass (as ?access_token=): the endpoint for passes with their setup locked.
LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"
#: A session must start this soon after the pass is made...
START_WITHIN = timedelta(minutes=1)
#: ...and can run this long. Google ends an audio session at 15 minutes in any case.
SESSION_FOR = timedelta(minutes=15)
TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class LivePass:
    token: str
    model: str
    expires_at: datetime


class LiveUnavailable(Exception):
    """Google made no pass: a refused key, a used-up quota, or no answer."""


def _iso(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def session_setup(model: str, voice: str, instructions: str, tools: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The session as the pass locks it: Rico answers in audio, in his voice, and both sides are transcribed for
    the captions."""
    setup: dict[str, Any] = {
        "model": f"models/{model}",
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
        "systemInstruction": {"parts": [{"text": instructions}]},
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
    }
    if tools:
        setup["tools"] = tools
    return setup


async def create_pass(
    api_key: str,
    model: str,
    voice: str,
    instructions: str,
    tools: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
    client: httpx.AsyncClient | None = None,
) -> LivePass:
    """A one-use pass for one Live session with Rico. Raises LiveUnavailable when Google won't make one."""
    now = now or datetime.now(UTC)
    body = {
        "uses": 1,
        "expireTime": _iso(now + SESSION_FOR),
        "newSessionExpireTime": _iso(now + START_WITHIN),
        "bidiGenerateContentSetup": session_setup(model, voice, instructions, tools),
    }
    # The key goes in a header, not the URL, so it never lands in access or error logs.
    headers = {"x-goog-api-key": api_key}
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as own:
                res = await own.post(TOKENS_URL, json=body, headers=headers)
        else:
            res = await client.post(TOKENS_URL, json=body, headers=headers)
        res.raise_for_status()
        token = str(res.json()["name"])
    except httpx.HTTPStatusError as err:
        log.warning("Gemini answered %s for a Live pass", err.response.status_code)
        raise LiveUnavailable from err
    except (httpx.HTTPError, ValueError, LookupError, TypeError) as err:
        log.warning("Gemini Live pass failed", exc_info=True)
        raise LiveUnavailable from err
    return LivePass(token=token, model=model, expires_at=now + SESSION_FOR)
