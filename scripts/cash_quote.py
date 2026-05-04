"""Fetch cash flight prices from Google Flights via fast-flights.

Called by the Node CLI as a subprocess. Reads args from CLI, prints JSON to stdout.

Usage:
  python cash_quote.py --from JFK --to LAX --date 2026-06-09 --cabin economy

Output (stdout):
  {
    "ok": true,
    "trips": [
      {
        "price": 234,
        "airlines": ["JetBlue Airways"],
        "stops": 0,
        "duration_minutes": 362,
        "departure": "2026-06-09T06:00:00",
        "arrival": "2026-06-09T09:02:00",
        "from": "JFK",
        "to": "LAX"
      },
      ...
    ]
  }

On failure, prints {"ok": false, "error": "..."} and exits 1.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import os
import sys
import traceback
from datetime import datetime
from typing import Any


CABINS = {
    "Economy": "economy",
    "Premium Economy": "premium-economy",
    "Business": "business",
    "First": "first",
}


def to_iso(dt: Any) -> str:
    # fast_flights SimpleDatetime: date=[y,m,d], time=[h,m]
    y, m, d = dt.date[0], dt.date[1], dt.date[2]
    hh, mm = dt.time[0], dt.time[1]
    return datetime(y, m, d, hh, mm).isoformat()


def _silence_fast_flights_debug_print() -> None:
    """fast_flights/parser.py has a stray `print(data)` that can't be safely
    captured via contextlib.redirect_stdout when multiple threads call
    get_flights concurrently (sys.stdout is process-global, so the redirect
    races and some prints leak through, corrupting our JSON output).

    Monkey-patch the parser module's `print` to a no-op. This is surgical
    and idempotent. Safe to call multiple times.
    """
    try:
        import fast_flights.parser as _ffparser
        _ffparser.print = lambda *_a, **_k: None  # type: ignore[attr-defined]
    except Exception:
        pass


def _run_query(
    from_airport: str,
    to_airport: str,
    date: str,
    cabin: str,
    adults: int = 1,
    airlines: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Run a single fast-flights query and return a list of trip dicts.

    `cabin` must already be in fast-flights format (lowercase-hyphen).
    `airlines`, if given, is a list of IATA carrier codes (e.g. ["B6"]).
    Raises on failure; callers decide how to handle.
    """
    _silence_fast_flights_debug_print()
    from fast_flights import (
        FlightQuery,
        Passengers,
        create_query,
        get_flights,
    )

    query = create_query(
        flights=[
            FlightQuery(
                date=date,
                from_airport=from_airport,
                to_airport=to_airport,
                airlines=airlines,
            )
        ],
        seat=cabin,
        trip="one-way",
        passengers=Passengers(adults=adults),
    )
    # fast_flights' parser.py has a stray debug print(data); redirect
    # stdout to /dev/null while we call into it so our only stdout output
    # is the JSON we emit at the end.
    with contextlib.redirect_stdout(io.StringIO()):
        res = get_flights(query)

    trips: list[dict[str, Any]] = []
    for trip in res:
        try:
            segments = list(trip.flights)
            if not segments:
                continue
            trips.append(
                {
                    "price": trip.price,
                    "airlines": list(trip.airlines),
                    "stops": max(0, len(segments) - 1),
                    "duration_minutes": sum(s.duration for s in segments),
                    "departure": to_iso(segments[0].departure),
                    "arrival": to_iso(segments[-1].arrival),
                    "from": segments[0].from_airport.code,
                    "to": segments[-1].to_airport.code,
                }
            )
        except Exception:
            # skip trips with unexpected shape
            continue
    return trips


def _normalize_cabin(cabin: str) -> str:
    """Map capitalized-with-spaces cabin (e.g. 'Premium Economy') to
    fast-flights lowercase-hyphen format. Pass through if already normalized."""
    if cabin in CABINS:
        return CABINS[cabin]
    return cabin.lower().replace(" ", "-")


async def _run_batch(items: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    sem = asyncio.Semaphore(5)
    results: dict[str, list[dict[str, Any]]] = {}

    async def worker(item: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
        date = item["date"]
        cabin_raw = item.get("cabin", "Economy")
        cabin = _normalize_cabin(cabin_raw)
        from_airport = item["from"]
        to_airport = item["to"]
        adults = int(item.get("adults", 1))
        airlines = item.get("airlines") or None
        if airlines is not None and not isinstance(airlines, list):
            airlines = None
        airline_tag = ",".join(airlines) if airlines else "*"
        key = f"{date}|{cabin_raw}|{airline_tag}"
        async with sem:
            try:
                trips = await asyncio.to_thread(
                    _run_query,
                    from_airport,
                    to_airport,
                    date,
                    cabin,
                    adults,
                    airlines,
                )
                return key, trips
            except Exception:
                return key, []

    tasks = [worker(it) for it in items]
    for coro in asyncio.as_completed(tasks):
        key, trips = await coro
        results[key] = trips
    return results


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--batch", action="store_true", help="Read JSON array of queries from stdin")
    p.add_argument("--from", dest="from_airport")
    p.add_argument("--to", dest="to_airport")
    p.add_argument("--date", help="YYYY-MM-DD")
    p.add_argument(
        "--cabin",
        default="economy",
        choices=["economy", "premium-economy", "business", "first"],
    )
    p.add_argument("--adults", type=int, default=1)
    args = p.parse_args()

    if args.batch:
        # Write results to a file path supplied via env var to avoid stdout
        # buffering/piping flakiness when called as a Node subprocess.
        out_path = os.environ.get("PY_OUT")
        raw = ""
        try:
            raw = sys.stdin.read()
            items = json.loads(raw)
            if not isinstance(items, list):
                raise ValueError("batch input must be a JSON array")
            results = asyncio.run(_run_batch(items))
            payload: dict[str, Any] = {"ok": True, "results": results}
            if out_path:
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(payload, f)
            else:
                json.dump(payload, sys.stdout)
                sys.stdout.flush()
            return 0
        except Exception as e:
            payload = {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()}
            if out_path:
                try:
                    with open(out_path, "w", encoding="utf-8") as f:
                        json.dump(payload, f)
                except Exception:
                    pass
            else:
                json.dump(payload, sys.stdout)
                sys.stdout.flush()
            return 1

    # Single-query mode (preserved exactly).
    if not (args.from_airport and args.to_airport and args.date):
        json.dump(
            {"ok": False, "error": "missing required args: --from, --to, --date"},
            sys.stdout,
        )
        return 1

    try:
        trips = _run_query(
            args.from_airport,
            args.to_airport,
            args.date,
            args.cabin,
            args.adults,
        )
        json.dump({"ok": True, "trips": trips}, sys.stdout)
        return 0
    except Exception as e:
        json.dump(
            {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()},
            sys.stdout,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
