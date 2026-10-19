"""
database.py – SQLite persistence layer for EchoTrace.

Schema
------
events
  id          INTEGER PRIMARY KEY AUTOINCREMENT
  timestamp   TEXT    (ISO-8601 UTC)
  room        TEXT    (user-supplied room tag)
  sound_class TEXT    (YAMNet display name)
  confidence  REAL    (0.0 – 1.0)
"""

import sqlite3
import datetime
from typing import List, Dict, Optional

from config import DB_PATH


# ---------------------------------------------------------------------------
# Initialisation
# ---------------------------------------------------------------------------

def init_db() -> None:
    """Create the database and events table if they do not already exist."""
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp   TEXT    NOT NULL,
                room        TEXT    NOT NULL DEFAULT 'Unknown',
                sound_class TEXT    NOT NULL,
                confidence  REAL    NOT NULL
            )
            """
        )
        # Index for fast time-range / text searches
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_events_sound ON events(sound_class)"
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Write helpers
# ---------------------------------------------------------------------------

def insert_event(
    sound_class: str,
    confidence: float,
    room: str = "Unknown",
    timestamp: Optional[str] = None,
) -> int:
    """
    Insert a detected sound event into the database.

    Returns the row id of the newly inserted record.
    """
    if timestamp is None:
        timestamp = datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"

    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO events (timestamp, room, sound_class, confidence) VALUES (?,?,?,?)",
            (timestamp, room, sound_class, confidence),
        )
        conn.commit()
        return cursor.lastrowid


# ---------------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------------

def get_recent_events(limit: int = 5) -> List[Dict]:
    """Return the *limit* most-recent events, newest first."""
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(
            "SELECT * FROM events ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        )
        return [dict(row) for row in cursor.fetchall()]


def search_events(
    query: str,
    room_filter: Optional[str] = None,
    limit: int = 100,
) -> List[Dict]:
    """
    Full-text search over sound_class and room columns.

    Parameters
    ----------
    query       : substring to search for (case-insensitive)
    room_filter : if not None / empty, also filter by exact room name
    limit       : maximum rows to return
    """
    sql = "SELECT * FROM events WHERE sound_class LIKE ?"
    params: list = [f"%{query}%"]

    if room_filter:
        sql += " AND room = ?"
        params.append(room_filter)

    sql += " ORDER BY timestamp DESC LIMIT ?"
    params.append(limit)

    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(sql, params)
        return [dict(row) for row in cursor.fetchall()]


def get_all_rooms() -> List[str]:
    """Return the distinct room names recorded so far."""
    with _connect() as conn:
        cursor = conn.execute("SELECT DISTINCT room FROM events ORDER BY room")
        return [row[0] for row in cursor.fetchall()]


def get_event_stats() -> Dict:
    """Return aggregate statistics for the dashboard."""
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        total = conn.execute("SELECT COUNT(*) as n FROM events").fetchone()["n"]
        today_str = datetime.datetime.utcnow().strftime("%Y-%m-%d")
        today = conn.execute(
            "SELECT COUNT(*) as n FROM events WHERE timestamp LIKE ?",
            (f"{today_str}%",),
        ).fetchone()["n"]
        top = conn.execute(
            "SELECT sound_class, COUNT(*) as n FROM events "
            "GROUP BY sound_class ORDER BY n DESC LIMIT 5"
        ).fetchall()
        return {
            "total": total,
            "today": today,
            "top_sounds": [dict(r) for r in top],
        }


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH, check_same_thread=False)
