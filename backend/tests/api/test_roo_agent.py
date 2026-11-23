"""Roo as an agent: it reads the trip and puts every change on one card; nothing changes until Do all, and
Undo takes it back. A scripted model (ROO_FAKE_LLM) stands in for Gemini, through the real API and database."""

from __future__ import annotations

import asyncio
import functools
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient
from geoalchemy2.elements import WKTElement

from app.adapters import guide
from app.adapters.llm import AgentUnavailable, agent_model, gemini_step
from app.config import get_settings
from app.db import session_scope
from app.main import app
from app.models import Place
from app.security import ROO_STEP_HEADER, ROO_STEP_SECRET
from app.services import booking_sim as sim
from app.services.roo_agent.tools import Refused, Step, Turn, _afford

from .conftest import key

SCRIPT = Path(__file__).parents[1] / "fixtures" / "roo_agent_script.json"
IST = timezone(timedelta(hours=5, minutes=30))


class NoNominatim:
    """Place search without the network: only the database's own places."""

    def __init__(self, *_):
        pass

    def search(self, query, where):
        return []

    def settlements(self, query):
        return []


@pytest.fixture
def agent(client, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ai_helper_enabled", True)
    monkeypatch.setattr(s, "roo_fake_llm", str(SCRIPT))
    monkeypatch.setattr("app.services.places.NominatimSearch", NoNominatim)
    monkeypatch.setattr("app.services.cities.NominatimSearch", NoNominatim)
    res = client.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()})
    assert res.status_code == 202, res.text
    return client


def _say(client, message: str, trip: str | None = "trip-001"):
    return client.post("/v1/roo/turns", json={"idempotencyKey": key(), "message": message, "tripId": trip})


def _post(client, path: str):
    return client.post(path, json={"idempotencyKey": key()})


def _trip(client) -> dict:
    return client.get("/v1/trips/trip-001").json()


def _state(trip: dict, task_id: str) -> str:
    return next(t["state"] for t in trip["tasks"] if t["taskId"] == task_id)


# ---------- the model ----------


def _gemini(seen: list[httpx.Request], content: dict | None = None, status: int = 200, error: dict | None = None) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if status != 200:
            return httpx.Response(status, json=error) if error else httpx.Response(status, json={"error": {"code": status}}, headers={"retry-after": "30"})
        return httpx.Response(200, json={"candidates": [{"content": content}]})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_each_step_sends_the_tools_and_keeps_the_models_message_as_it_came(monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "test-key")
    monkeypatch.setattr(get_settings(), "roo_fake_llm", "")
    seen: list[httpx.Request] = []
    said = {"role": "model", "parts": [{"functionCall": {"name": "get_day", "args": {}, "id": "c1"}, "thoughtSignature": "sig-1"}]}
    contents = [{"role": "user", "parts": [{"text": "Traveller: hi"}]}]
    tools = [{"name": "get_day", "description": "The day."}]

    out = asyncio.run(gemini_step("Be Roo.", contents, tools, client=_gemini(seen, said)))
    asyncio.run(gemini_step("Be Roo.", contents, tools, final=True, client=_gemini(seen, said)))

    # Echoed back exactly, thought signature and all: Gemini needs it on the next step.
    assert out == said
    first, last = (json.loads(r.content) for r in seen)
    assert seen[0].headers["x-goog-api-key"] == "test-key" and "test-key" not in str(seen[0].url)
    assert first["tools"] == [{"functionDeclarations": tools}] and first["toolConfig"]["functionCallingConfig"]["mode"] == "AUTO"
    assert first["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "low"}
    assert last["toolConfig"]["functionCallingConfig"]["mode"] == "NONE"


def test_when_a_models_quota_runs_out_roo_rests_it_and_uses_the_helpers_model(monkeypatch, fake_redis):
    s = get_settings()
    monkeypatch.setattr(s, "gemini_api_key", "test-key")
    monkeypatch.setattr(s, "roo_fake_llm", "")
    monkeypatch.setattr(s, "roo_agent_model", "gemini-3.5-flash")
    monkeypatch.setattr(s, "gemini_model", "gemini-3.5-flash-lite")
    seen: list[httpx.Request] = []
    daily = {"error": {"code": 429, "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "76530s"}]}}
    assert agent_model() == "gemini-3.5-flash"
    with pytest.raises(AgentUnavailable):
        asyncio.run(gemini_step("Be Roo.", [], [], model="gemini-3.5-flash", client=_gemini(seen, status=429, error=daily)))
    # Rested as long as Gemini said (the day's quota), and not asked again meanwhile.
    assert 76_000 < fake_redis.ttl("roo:llm:cooldown:gemini-3.5-flash") <= 76_530
    with pytest.raises(AgentUnavailable):
        asyncio.run(gemini_step("Be Roo.", [], [], model="gemini-3.5-flash", client=_gemini(seen, status=429)))
    assert len(seen) == 1 and "gemini-3.5-flash:" in str(seen[0].url)
    # The next message goes to the AI helper's model; with both out, the phone answers.
    assert agent_model() == "gemini-3.5-flash-lite"
    fake_redis.set("roo:llm:cooldown:gemini-3.5-flash-lite", "1", ex=60)
    assert agent_model() is None


def test_a_booking_the_wallet_cant_cover_needs_a_top_up_first():
    turn = Turn(api=None, trip=None, trips=[], simulated=True)  # type: ignore[arg-type]
    turn.wallet = 150
    with pytest.raises(Refused, match="top_up of at least ₹400"):
        asyncio.run(_afford(turn, 520))
    turn.steps.append(Step("s1", "top_up", "server", "Add ₹500 to your wallet", "wallet", {"amountInr": 500}, top_up_inr=500))
    asyncio.run(_afford(turn, 520))


# ---------- through the API ----------


@pytest.mark.db
def test_a_card_changes_nothing_until_do_all_and_undo_takes_it_back(agent):
    before = _trip(agent)
    version = before["activePlan"]["version"]
    balance = agent.get("/v1/wallet").json()["balanceInr"]

    res = _say(agent, "Skip the university office, get me a cab to the bank and go dark")
    assert res.status_code == 200, res.text
    out = res.json()
    assert "Tap Do all" in out["reply"]
    assert out["reads"] == ["Read your day", "Checked rides to Bank"]
    card = out["proposal"]
    assert [s["tool"] for s in card["steps"]] == ["skip_task", "book_cab", "set_theme"]
    assert [s["kind"] for s in card["steps"]] == ["server", "server", "phone"]
    assert card["steps"][0]["label"] == "Skip “University office”"
    assert card["steps"][2]["args"] == {"theme": "dark"} and card["steps"][0]["args"] == {}
    fare = card["steps"][1]["costInr"]
    assert card["totalCostInr"] == fare > 0

    # A card is only a card: the day, the bookings and the wallet are as they were.
    assert _state(_trip(agent), "task-office") == "planned"
    assert agent.get("/v1/trips/trip-001/bookings").json() == []
    assert agent.get("/v1/wallet").json()["balanceInr"] == balance

    ran = _post(agent, f"/v1/roo/proposals/{card['proposalId']}/execute")
    assert ran.status_code == 200, ran.text
    run = ran.json()
    assert run["state"] == "done" and run["canUndo"] and run["summary"] == "All 3 done."
    assert [s["status"] for s in run["steps"]] == ["done", "done", "phone"]
    assert [p["tool"] for p in run["phone"]] == ["set_theme"]
    after = _trip(agent)
    assert _state(after, "task-office") == "skipped" and after["activePlan"]["version"] > version
    (booking,) = agent.get("/v1/trips/trip-001/bookings").json()
    assert booking["status"] == "confirmed" and booking["toId"] == "task-bank"
    assert agent.get("/v1/wallet").json()["balanceInr"] == balance - booking["fareInr"]

    # Once only.
    again = _post(agent, f"/v1/roo/proposals/{card['proposalId']}/execute")
    assert again.status_code == 409 and again.json()["error"]["code"] == "ALREADY_DONE"

    undone = _post(agent, f"/v1/roo/proposals/{card['proposalId']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["state"] == "undone"
    assert agent.get("/v1/trips/trip-001/bookings").json()[0]["status"] == "cancelled"
    assert agent.get("/v1/wallet").json()["balanceInr"] == balance
    assert _trip(agent)["activePlan"]["version"] == version
    assert _post(agent, f"/v1/roo/proposals/{card['proposalId']}/undo").status_code == 409


@pytest.mark.db
def test_a_task_roo_adds_is_planned_in_and_undo_removes_it(agent):
    card = _say(agent, "Add dinner at 7 pm on 80 Feet Road").json()["proposal"]
    assert [s["tool"] for s in card["steps"]] == ["add_task", "plan_today"]
    assert card["steps"][1]["auto"] is True
    assert card["steps"][0]["detail"] == "Bank, 80 Feet Road, Wednesday at 19:00, 60 min"

    assert _post(agent, f"/v1/roo/proposals/{card['proposalId']}/execute").json()["state"] == "done"
    trip = _trip(agent)
    dinner = next(t for t in trip["tasks"] if t["title"] == "Dinner")
    assert datetime.fromisoformat(dinner["fixedStart"]).astimezone(IST) == datetime(2026, 10, 14, 19, 0, tzinfo=IST)
    assert dinner["taskId"] in {leg["taskId"] for leg in trip["activePlan"]["legs"]}

    assert _post(agent, f"/v1/roo/proposals/{card['proposalId']}/undo").status_code == 200
    assert all(t["title"] != "Dinner" for t in _trip(agent)["tasks"])


@pytest.mark.db
def test_roo_asks_once_when_a_detail_is_missing(agent):
    out = _say(agent, "Which one should I go to?").json()
    assert out["ask"] == {"question": "Which bank do you mean?", "options": ["SBI", "HDFC"]}
    assert out["reply"] == "Which bank do you mean?" and out["proposal"] is None


@pytest.mark.db
def test_a_change_the_api_would_refuse_never_reaches_the_card(agent):
    # It's 07:30 on the demo clock: 06:00 has passed, so the step goes back to Roo instead.
    out = _say(agent, "Move the meeting to 6 am").json()
    assert out["proposal"] is None and "already passed" in out["reply"]


@pytest.mark.db
def test_a_new_trip_its_task_and_its_first_plan_from_one_message(agent):
    out = _say(agent, "Start a new trip to Bengaluru with a bank visit", trip=None).json()
    card = out["proposal"]
    assert [s["tool"] for s in card["steps"]] == ["create_trip", "add_task", "plan_today"]
    assert card["final"] == ["The new trip stays."]
    run = _post(agent, f"/v1/roo/proposals/{card['proposalId']}/execute").json()
    assert run["state"] == "done" and run["tripId"] != "trip-001"
    trip = agent.get(f"/v1/trips/{run['tripId']}").json()
    assert [t["title"] for t in trip["tasks"]] == ["Bank"] and trip["activePlan"] is not None


@pytest.mark.db
def test_a_card_is_its_makers_and_goes_stale_when_the_day_changes(agent, client):
    card = _say(agent, "Skip the university office, get me a cab to the bank and go dark").json()["proposal"]
    other = TestClient(app, base_url="https://testserver")
    token = other.post("/v1/auth/signup", json={"name": "Meera", "email": "meera@example.com", "password": "a-long-password"}).json()["accessToken"]
    other.headers["Authorization"] = f"Bearer {token}"
    assert other.get(f"/v1/roo/proposals/{card['proposalId']}").status_code == 404
    assert other.post(f"/v1/roo/proposals/{card['proposalId']}/execute", json={"idempotencyKey": key()}).status_code == 404

    edited = agent.patch("/v1/trips/trip-001/tasks/task-bank", json={"durationMin": 90})
    assert edited.status_code == 200, edited.text
    stale = _post(agent, f"/v1/roo/proposals/{card['proposalId']}/execute")
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "STALE"


@pytest.mark.db
def test_the_agent_is_off_unless_switched_on_and_has_its_own_limit(agent, monkeypatch):
    monkeypatch.setattr(get_settings(), "roo_agent_per_minute", 1)
    assert _say(agent, "hello").status_code == 200
    assert _say(agent, "hello again").status_code == 429
    monkeypatch.setattr(get_settings(), "ai_helper_enabled", False)
    assert _say(agent, "hello").status_code == 404
    assert agent.get("/v1/me").json()["features"]["agent"] is False


# ---------- Rico as a guide ----------

#: Wikivoyage's guide and OpenStreetMap's sights, as the real adapter reads them.
GUIDE_WIKITEXT = "==See==\n* {{see | name=Lalbagh Botanical Garden | wikidata=Q200711 | content=Glasshouse. }}\n"
WIKIVOYAGE_ANSWER = {
    "query": {
        "pages": [
            {
                "title": "Bengaluru",
                "extract": "Bengaluru (Kannada: ಬೆಂಗಳೂರು) is the largest city in southern India.",
                "revisions": [{"slots": {"main": {"content": GUIDE_WIKITEXT}}}],
            }
        ]
    }
}
OVERPASS_ANSWER = {"elements": [{"type": "node", "id": 1, "lat": 12.9507, "lon": 77.5848, "tags": {"name": "Lalbagh Botanical Garden", "leisure": "garden"}}]}


@pytest.fixture
def sources(monkeypatch):
    """Wikivoyage and Overpass answer here, through the real adapter; this is what they were asked."""
    s = get_settings()
    monkeypatch.setattr(s, "wikivoyage_url", "https://en.wikivoyage.org/w/api.php")
    monkeypatch.setattr(s, "overpass_url", "https://overpass-api.de/api/interpreter")
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=WIKIVOYAGE_ANSWER if request.url.host == "en.wikivoyage.org" else OVERPASS_ANSWER)

    client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    monkeypatch.setattr(guide, "city_guide", functools.partial(guide.city_guide, client=client))
    monkeypatch.setattr(guide, "places_near", functools.partial(guide.places_near, client=client))
    return seen


@pytest.mark.db
def test_rico_shows_a_newcomer_round_from_the_city_guide_and_the_map(agent, sources):
    said = {"idempotencyKey": key(), "message": "I'm new here, what should I see?", "tripId": "trip-001", "mode": "tourist"}
    res = agent.post("/v1/roo/turns", json=said)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["reads"] == ["Read the Wikivoyage guide to Bengaluru", "Looked for sights near Hotel near Majestic"]
    assert out["reply"].endswith("Want me to plan your whole day, tickets and all?") and out["proposal"] is None
    wikivoyage, overpass = sources
    assert wikivoyage.url.params["titles"] == "Bengaluru"
    # Overpass sees only the area: where they're staying, rounded to about a kilometre.
    assert "(around:5800,12.98,77.57)" in parse_qs(overpass.content.decode())["data"][0]


@pytest.mark.db
def test_rico_plans_the_day_tickets_and_all_and_undo_gives_the_money_back(agent):
    with session_scope() as db:
        point = {"lng": 77.5848, "lat": 12.9507, "location": WKTElement("POINT(77.5848 12.9507)", srid=4326)}
        db.add(Place(place_id="osm-w-lalbagh", city_slug="bengaluru", name="Lalbagh Botanical Garden", area="Lalbagh", **point))
    balance = agent.get("/v1/wallet").json()["balanceInr"]
    entry = sim.ticket_options("osm-w-lalbagh")[0].fare_inr

    card = _say(agent, "Yes, plan my whole day, tickets and all").json()["proposal"]
    assert [s["tool"] for s in card["steps"]] == ["add_task", "book_ticket", "plan_today"]
    tickets = card["steps"][1]
    assert (tickets["label"], tickets["icon"], tickets["costInr"]) == ("Book tickets to Lalbagh Botanical Garden", "ticket", 2 * entry)
    assert tickets["detail"] == "Entry for 2 people on Wednesday, from SightPass" and card["totalCostInr"] == 2 * entry
    assert agent.get("/v1/trips/trip-001/bookings").json() == []

    run = _post(agent, f"/v1/roo/proposals/{card['proposalId']}/execute").json()
    assert run["state"] == "done", run
    (booking,) = agent.get("/v1/trips/trip-001/bookings").json()
    assert (booking["kind"], booking["status"], booking["provider"], booking["fareInr"]) == ("ticket", "confirmed", "sightpass", 2 * entry)
    assert (booking["details"]["place"], booking["details"]["date"], booking["details"]["visitors"]) == ("Lalbagh Botanical Garden", "2026-10-14", 2)
    assert agent.get("/v1/wallet").json()["balanceInr"] == balance - 2 * entry
    trip = _trip(agent)
    lalbagh = next(t for t in trip["tasks"] if t["title"] == "Lalbagh Botanical Garden")
    assert lalbagh["taskId"] in {leg["taskId"] for leg in trip["activePlan"]["legs"]}

    # Undo cancels the tickets (the money comes back) and takes the visit out of the day.
    assert _post(agent, f"/v1/roo/proposals/{card['proposalId']}/undo").status_code == 200
    assert agent.get("/v1/trips/trip-001/bookings").json()[0]["status"] == "cancelled"
    assert agent.get("/v1/wallet").json()["balanceInr"] == balance
    assert all(t["title"] != "Lalbagh Botanical Garden" for t in _trip(agent)["tasks"])


@pytest.mark.db
def test_only_roos_own_calls_skip_the_per_minute_limit(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "rate_limit_per_minute", 1)
    assert client.get("/v1/me", headers={ROO_STEP_HEADER: "guess"}).status_code == 200
    assert client.get("/v1/me", headers={ROO_STEP_HEADER: "guess"}).status_code == 429
    assert all(client.get("/v1/me", headers={ROO_STEP_HEADER: ROO_STEP_SECRET}).status_code == 200 for _ in range(3))
