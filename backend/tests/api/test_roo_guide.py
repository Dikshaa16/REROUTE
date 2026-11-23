"""Rico as a local guide: the tools that read a city's guide, places near a point and the web, simulated entry
tickets on the card, and tourist mode. The guide's sources and the app's API are stood in for here; the same
through the real API and database is in test_roo_agent.py."""

from __future__ import annotations

import asyncio

import pytest
from pydantic import ValidationError

from app.adapters import guide
from app.schemas import RooAgentIn
from app.services import booking_sim as sim
from app.services.roo_agent.agent import run_turn
from app.services.roo_agent.prompt import SYSTEM, system_prompt
from app.services.roo_agent.tools import Turn, call_tool, declarations

TRIP = {
    "tripId": "trip-001",
    "citySlug": "bengaluru",
    "cityName": "Bengaluru",
    "startDate": "2026-10-14",
    "endDate": "2026-10-15",
    "utcOffset": "+05:30",
    "now": "2026-10-14T07:30:00+05:30",
    "day": "2026-10-14",
    "stayLabel": "Hotel near Majestic",
    "stayPlace": {"placeId": "hotel-majestic", "name": "Hotel near Majestic", "area": "Majestic", "lat": 12.9767, "lng": 77.5713},
    "tasks": [
        {"taskId": "task-bank", "place": {"placeId": "koramangala-bank", "name": "Bank, 80 Feet Road", "area": "Koramangala", "lat": 12.9352, "lng": 77.6195}}
    ],
}
LALBAGH = {"placeId": "osm-w-lalbagh", "name": "Lalbagh Botanical Garden", "area": "Lalbagh", "lat": 12.9507, "lng": 77.5848}
GUIDE = guide.CityGuide(
    title="Bengaluru",
    summary="Bengaluru is the largest city in southern India.",
    see=(guide.Listing("Lalbagh Botanical Garden", "A glasshouse and old trees.", "6AM-7PM", "", True),),
    eat=(guide.Listing("Vidyarthi Bhavan", price="₹80"),),
    lat=12.974,
    lng=77.594,
)


class FakeApi:
    """The app's API as Rico's tools call it: an answer for each path, and what was asked."""

    def __init__(self, answers: dict):
        self.answers = answers
        self.asked: list[tuple[str, dict]] = []

    async def get(self, path: str, **params):
        self.asked.append((path, params))
        return self.answers[path]


def _turn(api: FakeApi | None = None, trip: dict | None = TRIP) -> Turn:
    return Turn(api=api or FakeApi({}), trip=trip, trips=[], simulated=True)  # type: ignore[arg-type]


def _call(turn: Turn, name: str, **args) -> dict:
    return asyncio.run(call_tool(turn, name, args))


# ---------- reading the guide ----------


def test_city_guide_reads_the_trips_city_unless_told_another(monkeypatch):
    asked: list[str] = []

    async def city_guide(city, client=None):
        asked.append(city)
        return GUIDE if city == "Bengaluru" else None

    monkeypatch.setattr(guide, "city_guide", city_guide)
    turn = _turn()
    assert _call(turn, "city_guide") == {
        "city": "Bengaluru",
        "summary": "Bengaluru is the largest city in southern India.",
        "see": [{"name": "Lalbagh Botanical Garden", "about": "A glasshouse and old trees.", "hours": "6AM-7PM"}],
        "do": [],
        "eat": [{"name": "Vidyarthi Bhavan", "price": "₹80"}],
        "source": "Wikivoyage",
    }
    assert turn.reads == ["Read the Wikivoyage guide to Bengaluru"]
    assert _call(turn, "city_guide", city=" Atlantis ") == {
        "ok": False,
        "error": "Wikivoyage has no guide to Atlantis, or didn't answer. Try places_near, or look_up.",
    }
    assert asked == ["Bengaluru", "Atlantis"] and len(turn.reads) == 1
    assert _call(_turn(trip=None), "city_guide") == {"ok": False, "error": "Say which city."}


def test_places_near_looks_around_the_stay_a_place_a_search_or_a_city(monkeypatch):
    points: list[tuple[float, float, str]] = []

    async def places_near(lat, lng, kind, client=None):
        points.append((lat, lng, kind))
        return [
            guide.Sight("Cubbon Park", "park", 12.97, 77.59, 1240),
            guide.Sight("Lalbagh Botanical Garden", "garden", 12.95, 77.58, 2960, True),
            guide.Sight("Sankey Tank", "park", 13.01, 77.57, 3500),
        ]

    async def city_guide(city, client=None):
        return GUIDE if city == "Bengaluru" else None

    monkeypatch.setattr(guide, "places_near", places_near)
    monkeypatch.setattr(guide, "city_guide", city_guide)
    api = FakeApi({"/v1/places": [LALBAGH]})
    turn = _turn(api)

    # Where they're staying, the better known first, then the nearest.
    out = _call(turn, "places_near", kind="do")
    assert points[-1] == (12.9767, 77.5713, "do")
    assert out == {
        "near": "Hotel near Majestic",
        "places": [
            {"name": "Lalbagh Botanical Garden", "what": "garden", "km": 3.0, "wellKnown": True},
            {"name": "Cubbon Park", "what": "park", "km": 1.2},
            {"name": "Sankey Tank", "what": "park", "km": 3.5},
        ],
    }
    assert turn.reads == ["Looked for things to do near Hotel near Majestic"]
    # A place of the day, by its placeId.
    assert _call(turn, "places_near", kind="eat", place="koramangala-bank")["near"] == "Bank, 80 Feet Road"
    assert points[-1] == (12.9352, 77.6195, "eat") and api.asked == []
    # A place by name: searched in the trip's city, and kept so it can go on the card.
    assert _call(turn, "places_near", kind="see", place="Lalbagh")["near"] == "Lalbagh Botanical Garden"
    assert api.asked == [("/v1/places", {"q": "Lalbagh", "city": "bengaluru"})] and "osm-w-lalbagh" in turn.places
    # A city: its guide's centre.
    no_trip = _turn(FakeApi({}), trip=None)
    assert _call(no_trip, "places_near", kind="see", place="Bengaluru")["near"] == "Bengaluru"
    assert points[-1] == (12.974, 77.594, "see")
    # A point.
    assert _call(no_trip, "places_near", kind="see", lat=12.95, lng=77.58)["near"] == "that point"


def test_places_near_says_why_when_it_cant_look(monkeypatch):
    async def nothing(lat, lng, kind, client=None):
        return []

    async def no_guide(city, client=None):
        return None

    monkeypatch.setattr(guide, "places_near", nothing)
    monkeypatch.setattr(guide, "city_guide", no_guide)
    turn = _turn(FakeApi({"/v1/places": []}))
    assert _call(turn, "places_near", kind="shop")["error"] == "kind is see, do or eat."
    assert _call(turn, "places_near", kind="see", lat=51.5, lng=-0.12)["error"] == "lat and lng go together, and make a point in India."
    assert _call(turn, "places_near", kind="see", lat=12.95)["error"] == "lat and lng go together, and make a point in India."
    nowhere = _call(turn, "places_near", kind="see", place="Nowhere Lane")
    assert nowhere["error"] == "I couldn't find “Nowhere Lane”. Find it with search_places, or name a city."
    assert _call(_turn(trip=None), "places_near", kind="see")["error"] == "Say near where: a place from search_places, or a city."
    empty = _call(turn, "places_near", kind="eat")
    assert empty["places"] == [] and empty["note"].startswith("Nothing came back")


def test_look_up_answers_with_its_sources_or_says_it_couldnt(monkeypatch):
    async def web_answer(question, client=None):
        if "Lalbagh" not in question:
            return None
        return guide.WebAnswer("Open 6 AM to 7 PM; entry is ₹30.", (guide.Source("horticulture.karnataka.gov.in", "https://example.org/r/1"),))

    monkeypatch.setattr(guide, "web_answer", web_answer)
    turn = _turn()
    question = "When is Lalbagh Botanical Garden in Bengaluru open, and what does entry cost for an adult visitor?"
    assert _call(turn, "look_up", question=question) == {
        "answer": "Open 6 AM to 7 PM; entry is ₹30.",
        "sources": [{"title": "horticulture.karnataka.gov.in", "url": "https://example.org/r/1"}],
    }
    assert turn.reads == ["Searched the web for “When is Lalbagh Botanical Garden in Bengaluru open, and…”"]
    assert _call(turn, "look_up", question="Is it raining?")["error"].startswith("The web search didn't answer just now.")
    assert _call(turn, "look_up")["error"] == "Give the question."
    # Three a message: each takes a few seconds and spends the search quota.
    assert _call(turn, "look_up", question=question)["answer"]
    assert _call(turn, "look_up", question=question)["error"] == "That's 3 web searches for one message: answer with what you have."


def test_the_guide_is_there_with_or_without_a_trip_and_tickets_only_where_bookings_are():
    names = {d["name"] for d in declarations(_turn(trip=None))}
    assert {"city_guide", "places_near", "look_up", "ticket_options", "book_ticket"} <= names
    real = Turn(api=None, trip=TRIP, trips=[], simulated=False)  # type: ignore[arg-type]
    names = {d["name"] for d in declarations(real)}
    assert {"city_guide", "places_near", "look_up"} <= names and not {"ticket_options", "book_ticket"} & names


# ---------- entry tickets on the card ----------


def test_entry_tickets_go_on_the_card_priced_from_the_place_and_paid_from_the_wallet():
    turn = _turn(FakeApi({"/v1/wallet": {"balanceInr": 5000, "entries": []}}))
    turn.places[LALBAGH["placeId"]] = {**LALBAGH, "city": "bengaluru"}
    entry, guided = sim.ticket_options(LALBAGH["placeId"])
    assert 20 <= entry.fare_inr <= 300 and guided.fare_inr > entry.fare_inr
    assert sim.ticket_options(LALBAGH["placeId"]) == [entry, guided]  # always the same

    assert _call(turn, "ticket_options", placeId=LALBAGH["placeId"]) == {
        "place": "Lalbagh Botanical Garden",
        "tickets": [
            {"ticket": "entry", "label": "Entry", "fareInrEach": entry.fare_inr},
            {"ticket": "guided", "label": "Entry and a guided tour", "fareInrEach": guided.fare_inr},
        ],
        "simulated": True,
    }
    out = _call(turn, "book_ticket", placeId=LALBAGH["placeId"], ticket="guided", visitors=2, day="2026-10-15")
    assert out["ok"] and out["onCard"] == "Book tickets to Lalbagh Botanical Garden"
    (step,) = turn.steps
    assert (step.kind, step.icon, step.cost_inr) == ("server", "ticket", 2 * guided.fare_inr)
    assert step.detail == "Entry and a guided tour for 2 people on Thursday, from SightPass"
    assert step.args == {"tripId": "trip-001", "placeId": "osm-w-lalbagh", "day": "2026-10-15", "optionId": "guided", "visitors": 2}
    # Plain entry for one, today, unless they say.
    assert _call(turn, "book_ticket", placeId=LALBAGH["placeId"])["ok"]
    assert turn.steps[1].args["optionId"] == "entry" and turn.steps[1].args["day"] == "2026-10-14" and turn.steps[1].cost_inr == entry.fare_inr

    assert _call(turn, "book_ticket", placeId=LALBAGH["placeId"])["error"] == "Tickets to Lalbagh Botanical Garden that day are already on the card."
    assert _call(turn, "book_ticket", placeId="osm-w-unknown")["error"].startswith("osm-w-unknown didn't come from search_places")
    assert _call(turn, "book_ticket", placeId=LALBAGH["placeId"], day="2026-10-20")["error"] == "That's outside the trip (2026-10-14 to 2026-10-15)."
    assert _call(turn, "book_ticket", placeId=LALBAGH["placeId"], day="2026-10-15", ticket="vip")["error"] == "ticket is entry or guided."
    assert _call(turn, "book_ticket", placeId=LALBAGH["placeId"], day="2026-10-15", visitors=11)["error"] == "visitors must be a whole number from 1 to 10."


def test_tickets_the_wallet_cant_cover_need_a_top_up_first():
    turn = _turn(FakeApi({"/v1/wallet": {"balanceInr": 10, "entries": []}}))
    turn.places[LALBAGH["placeId"]] = {**LALBAGH, "city": "bengaluru"}
    assert "Put a top_up of at least ₹" in _call(turn, "book_ticket", placeId=LALBAGH["placeId"], visitors=10)["error"]
    assert turn.steps == []


# ---------- tourist mode ----------


def test_tourist_mode_makes_rico_a_local_guide_with_the_same_rules():
    tourist = system_prompt("tourist")
    assert system_prompt(None) == SYSTEM and tourist.startswith(SYSTEM)
    assert "local guide" in tourist and "warm and playful" in tourist
    assert "whether they'd like recommendations or already have places in mind" in tourist
    assert "Recommend 3 to 5 places, each with a one-line reason" in tourist and "never recommend a place from memory" in tourist
    assert '"Want me to plan your whole day, tickets and all?"' in tourist and "on one card" in tourist
    # Rico's own rules still hold: one card, nothing invented.
    assert "single card" in SYSTEM and "Never invent a place" in SYSTEM and "Recommend only places a tool gave you" in SYSTEM

    said = {"idempotencyKey": "test-tourist-1", "message": "I'm new here!"}
    assert RooAgentIn.model_validate({**said, "mode": "tourist"}).mode == "tourist"
    assert RooAgentIn.model_validate(said).mode is None
    with pytest.raises(ValidationError):
        RooAgentIn.model_validate({**said, "mode": "pirate"})


def test_a_tourist_message_reaches_the_model_with_the_guide(monkeypatch):
    seen: list[tuple[str, set[str]]] = []

    async def step(system, contents, tools, *, model=None, final=False, client=None):
        seen.append((system, {t["name"] for t in tools}))
        return {"role": "model", "parts": [{"text": "Welcome to Bengaluru! Shall I suggest a few places, or do you have some in mind?"}]}

    monkeypatch.setattr("app.services.roo_agent.agent.gemini_step", step)
    api = FakeApi({"/v1/trips": {"items": []}})
    out = asyncio.run(run_turn(api, "usr-1", "I'm new here", [], None, "tourist"))  # type: ignore[arg-type]
    assert out["reply"].startswith("Welcome to Bengaluru!") and out["proposal"] is None
    asyncio.run(run_turn(api, "usr-1", "Plan my day", [], None))  # type: ignore[arg-type]
    (tourist, tools), (usual, _) = seen
    assert tourist == system_prompt("tourist") and usual == SYSTEM
    assert {"city_guide", "places_near", "look_up"} <= tools
