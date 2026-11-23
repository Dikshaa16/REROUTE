"""Roo, the agent: a message in, Roo's reply out, with at most one card of changes. The card changes nothing
until the traveller taps Do all; Undo takes it back. On only with AI_HELPER_ENABLED and a Gemini key."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from app.adapters import gemini_live
from app.adapters.llm import AgentUnavailable
from app.clock import now_for
from app.config import get_settings
from app.deps import CurrentUser, Db
from app.errors import ApiError
from app.models import Trip
from app.redis_client import get_redis
from app.schemas import PostBody, RooAgentIn, RooAgentOut, RooLiveIn, RooLiveOut, RooProposalOut, RooRunOut
from app.services import roo_voice
from app.services.roo import day_context
from app.services.roo_agent import proposals
from app.services.roo_agent.agent import run_turn
from app.services.roo_agent.internal import CallFailed, InternalApi
from app.services.views import trip_out

router = APIRouter(prefix="/v1/roo", tags=["roo"])


def _agent_on() -> None:
    s = get_settings()
    if not (s.ai_helper_enabled and (s.gemini_api_key or s.roo_fake_llm)):
        raise ApiError(404, "Rico's agent isn't switched on for this server.")


def _within_limits(user_id: str) -> None:
    """Each message may call the model several times, so the agent has its own limits per traveller."""
    s = get_settings()
    r = get_redis()
    minute, day = f"roo:agent:m:{user_id}:{int(time.time() // 60)}", f"roo:agent:d:{user_id}:{time.strftime('%Y-%m-%d')}"
    used_minute, used_day = r.incr(minute), r.incr(day)
    if used_minute == 1:
        r.expire(minute, 70)
    if used_day == 1:
        r.expire(day, 25 * 3600)
    if used_minute > s.roo_agent_per_minute or used_day > s.roo_agent_per_day:
        raise ApiError(429, "Rico needs a breather. Try again in a minute.", code="RATE_LIMITED", headers={"Retry-After": "60"})


def _api(request: Request) -> InternalApi:
    return InternalApi(request.app, request.headers.get("authorization", ""))


def _mine(proposal_id: str, user_id: str) -> dict:
    proposal = proposals.load(proposal_id, user_id)
    if proposal is None:
        raise ApiError(404, "That suggestion has expired. Ask Rico again.")
    return proposal


@router.post(
    "/turns", response_model=RooAgentOut, response_model_by_alias=True, summary="Talk to Rico: it reads your trip and puts any changes on one card (AI helper)"
)
async def turn(body: RooAgentIn, request: Request, user: CurrentUser) -> RooAgentOut:
    _agent_on()
    await run_in_threadpool(_within_limits, user.user_id)
    async with _api(request) as api:
        try:
            out = await run_turn(api, user.user_id, body.message, [(t.role, t.text) for t in body.history], body.trip_id, body.mode)
        except AgentUnavailable as exc:
            raise ApiError(503, "Rico can't think that through right now. Try again in a moment.", code="UNAVAILABLE") from exc
        except CallFailed as exc:
            raise ApiError(exc.status if exc.status in (404, 409) else 502, exc.message, code=exc.code) from exc
    return RooAgentOut.model_validate(out)


@router.post(
    "/live",
    response_model=RooLiveOut,
    response_model_by_alias=True,
    summary="Talk to Rico out loud: a pass for one realtime voice session (Gemini Live, AI helper)",
)
async def live(body: RooLiveIn, user: CurrentUser, db: Db) -> RooLiveOut:
    """Rico's voice, instructions and his one tool are locked into the pass, with the day in words, so the app
    can't change who he is; the Gemini key stays here."""
    s = get_settings()
    if not (s.ai_helper_enabled and s.gemini_api_key):
        raise ApiError(404, "Talking with Rico out loud isn't switched on for this server.")
    await run_in_threadpool(_within_limits, user.user_id)
    day = None
    if body.trip_id:
        trip = db.get(Trip, body.trip_id)
        # Same answer for "missing" and "not yours", as for every trip route.
        if trip is None or trip.user_id != user.user_id:
            raise ApiError(404, "Trip not found.")
        day = day_context(await run_in_threadpool(trip_out, db, trip, now_for(trip.trip_id)))
    try:
        found = await gemini_live.create_pass(
            s.gemini_api_key, s.roo_live_model, s.roo_live_voice, roo_voice.instructions(day, body.mode), [roo_voice.ASK_REROUTE]
        )
    except gemini_live.LiveUnavailable as exc:
        raise ApiError(503, "Rico can't talk out loud right now. Try the chat, or again in a moment.", code="UNAVAILABLE") from exc
    return RooLiveOut(token=found.token, url=gemini_live.LIVE_URL, model=found.model, expires_at=found.expires_at, pitch=s.roo_live_pitch)


@router.get("/proposals/{proposal_id}", response_model=RooProposalOut, response_model_by_alias=True, summary="A card Rico made, while it's kept")
def get_proposal(proposal_id: str, user: CurrentUser) -> RooProposalOut:
    return RooProposalOut.model_validate(proposals.view(_mine(proposal_id, user.user_id)))


@router.post("/proposals/{proposal_id}/execute", response_model=RooRunOut, response_model_by_alias=True, summary="Do everything on Rico's card, in order")
async def execute(proposal_id: str, body: PostBody, request: Request, user: CurrentUser) -> RooRunOut:
    _agent_on()
    proposal = await run_in_threadpool(_mine, proposal_id, user.user_id)
    if proposal["state"] != "ready":
        raise ApiError(409, "Rico has already done this.", code="ALREADY_DONE")
    if not await run_in_threadpool(proposals.claim, proposal_id):
        raise ApiError(409, "Rico is already on it.", code="IN_PROGRESS")
    try:
        async with _api(request) as api:
            trip = await api.get(f"/v1/trips/{proposal['tripId']}") if proposal["tripId"] else None
            # Made for the day as it was: if a task or the fixes on offer changed since, ask again.
            if proposals.fingerprint(trip) != proposal["fingerprint"]:
                raise ApiError(409, "Your day changed since Rico suggested this. Ask again and Rico will look at it as it is now.", code="STALE")
            out = await proposals.execute(api, proposal, trip)
    except CallFailed as exc:
        raise ApiError(exc.status if exc.status in (404, 409) else 502, exc.message, code=exc.code) from exc
    finally:
        await run_in_threadpool(proposals.release, proposal_id)
    return RooRunOut.model_validate(out)


@router.post("/proposals/{proposal_id}/undo", response_model=RooRunOut, response_model_by_alias=True, summary="Take back what Rico's card did")
async def undo(proposal_id: str, body: PostBody, request: Request, user: CurrentUser) -> RooRunOut:
    _agent_on()
    proposal = await run_in_threadpool(_mine, proposal_id, user.user_id)
    if proposal["state"] not in ("done", "partial") or not proposal.get("run", {}).get("canUndo"):
        raise ApiError(409, "There's nothing of this to undo.", code="NOTHING_TO_UNDO")
    if not await run_in_threadpool(proposals.claim, proposal_id):
        raise ApiError(409, "Rico is already on it.", code="IN_PROGRESS")
    try:
        async with _api(request) as api:
            out = await proposals.undo(api, proposal)
    except CallFailed as exc:
        raise ApiError(exc.status if exc.status in (404, 409) else 502, exc.message, code=exc.code) from exc
    finally:
        await run_in_threadpool(proposals.release, proposal_id)
    return RooRunOut.model_validate(out)
