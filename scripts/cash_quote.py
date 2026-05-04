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


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="from_airport", required=True)
    p.add_argument("--to", dest="to_airport", required=True)
    p.add_argument("--date", required=True, help="YYYY-MM-DD")
    p.add_argument(
        "--cabin",
        default="economy",
        choices=["economy", "premium-economy", "business", "first"],
    )
    p.add_argument("--adults", type=int, default=1)
    args = p.parse_args()

    try:
        from fast_flights import (
            FlightQuery,
            Passengers,
            create_query,
            get_flights,
        )

        query = create_query(
            flights=[
                FlightQuery(
                    date=args.date,
                    from_airport=args.from_airport,
                    to_airport=args.to_airport,
                )
            ],
            seat=args.cabin,
            trip="one-way",
            passengers=Passengers(adults=args.adults),
        )
        # fast_flights' parser.py has a stray debug print(data); redirect
        # stdout to /dev/null while we call into it so our only stdout output
        # is the JSON we emit at the end.
        with contextlib.redirect_stdout(io.StringIO()):
            res = get_flights(query)

        trips: list[dict[str, Any]] = []
        # `res` is a MetaList of Flights objects (each Flights is one trip option).
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
