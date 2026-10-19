"""
app.py – EchoTrace Streamlit UI  (v2 – redesigned)
====================================================
Run with:  py -m streamlit run app.py
"""

from __future__ import annotations

import logging
import datetime

import pandas as pd
import streamlit as st

import database
import detector
from audio_capture import get_capture_instance
from config import TARGET_CLASSES

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
)

# ── Page config ──────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="EchoTrace · Sound Memory",
    page_icon="🎧",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── CSS ──────────────────────────────────────────────────────────────────────
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

html, body, [class*="css"] { font-family: 'Inter', sans-serif; }

/* Background */
.stApp {
    background: #0d1117;
}

/* Sidebar */
[data-testid="stSidebar"] {
    background: #161b22 !important;
    border-right: 1px solid #30363d;
}
[data-testid="stSidebar"] * { color: #e6edf3 !important; }

/* Main text */
.stApp, .stMarkdown, p, span, label { color: #e6edf3; }

h1 { color: #ffffff !important; font-size: 2rem !important; font-weight: 700 !important; }
h2 { color: #e6edf3 !important; font-size: 1.4rem !important; font-weight: 600 !important; }
h3 { color: #c9d1d9 !important; font-size: 1.1rem !important; font-weight: 600 !important; }

/* Metric cards */
[data-testid="metric-container"] {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 10px;
    padding: 20px !important;
}
[data-testid="metric-container"] label { color: #8b949e !important; font-size: 0.8rem !important; text-transform: uppercase; letter-spacing: 0.05em; }
[data-testid="metric-container"] [data-testid="stMetricValue"] { color: #ffffff !important; font-size: 2rem !important; font-weight: 700 !important; }

/* Event card */
.ev-card {
    background: #161b22;
    border: 1px solid #30363d;
    border-left: 3px solid #58a6ff;
    border-radius: 8px;
    padding: 14px 18px;
    margin-bottom: 8px;
}
.ev-card:hover { border-left-color: #79c0ff; }
.ev-title { font-size: 1rem; font-weight: 600; color: #e6edf3; }
.ev-meta  { font-size: 0.8rem; color: #8b949e; margin-top: 4px; }
.ev-conf  { float: right; font-size: 0.85rem; font-weight: 600; color: #58a6ff; }

/* Status pills */
.pill {
    display: inline-block;
    padding: 5px 14px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.04em;
}
.pill-live  { background: #0d4429; color: #3fb950; border: 1px solid #238636; }
.pill-idle  { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
.pill-ready { background: #0d2d6e; color: #58a6ff; border: 1px solid #1f6feb; }
.pill-loading { background: #271d0a; color: #e3b341; border: 1px solid #9e6a03; }

/* Buttons */
.stButton > button {
    background: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 8px;
    font-weight: 600;
    padding: 0.5rem 1rem;
    transition: all 0.2s;
    width: 100%;
}
.stButton > button:hover {
    background: #30363d;
    border-color: #58a6ff;
    color: #58a6ff;
}
[data-testid="stBaseButton-primary"] > button,
.stButton > button[kind="primary"] {
    background: #238636 !important;
    border-color: #2ea043 !important;
    color: #ffffff !important;
}
[data-testid="stBaseButton-primary"] > button:hover,
.stButton > button[kind="primary"]:hover {
    background: #2ea043 !important;
}

/* Selectbox */
.stSelectbox [data-baseweb="select"] {
    background: #21262d !important;
    border: 1px solid #30363d !important;
    border-radius: 8px !important;
}
.stSelectbox label { color: #8b949e !important; font-size: 0.8rem !important; }

/* Text input */
.stTextInput input {
    background: #21262d !important;
    border: 1px solid #30363d !important;
    color: #e6edf3 !important;
    border-radius: 8px !important;
}
.stTextInput input:focus { border-color: #58a6ff !important; }

/* Divider */
hr { border-color: #30363d !important; }

/* Dataframe */
.stDataFrame { border-radius: 8px; overflow: hidden; }
.stDataFrame th { background: #161b22 !important; color: #8b949e !important; }
.stDataFrame td { background: #0d1117 !important; color: #e6edf3 !important; }

/* Info / warning boxes */
.stInfo { background: #0d2d6e !important; border: 1px solid #1f6feb !important; color: #e6edf3 !important; }
.stWarning { background: #271d0a !important; border: 1px solid #9e6a03 !important; color: #e6edf3 !important; }
.stSuccess { background: #0d4429 !important; border: 1px solid #238636 !important; color: #e6edf3 !important; }
.stError { background: #4d0000 !important; border: 1px solid #f85149 !important; color: #e6edf3 !important; }

/* Expander */
.streamlit-expanderHeader { background: #161b22 !important; border: 1px solid #30363d !important; border-radius: 8px !important; color: #e6edf3 !important; }

/* Chart */
.stVegaLiteChart { background: transparent !important; }

/* Caption */
.stCaption { color: #8b949e !important; }

/* Section wrapper */
.section-box {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 16px;
}
</style>
""", unsafe_allow_html=True)

# ── Init ─────────────────────────────────────────────────────────────────────
database.init_db()
capture = get_capture_instance()

if "room" not in st.session_state:
    st.session_state["room"] = "Living Room"

# ── SIDEBAR ───────────────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("## 🎧 EchoTrace")
    st.caption("Privacy-first ambient sound memory for dementia caregivers.")
    st.divider()

    # Room
    ROOMS = ["Living Room", "Kitchen", "Bedroom", "Bathroom",
             "Hallway", "Garden", "Dining Room", "Office"]
    selected_room = st.selectbox("📍 Room", ROOMS,
        index=ROOMS.index(st.session_state["room"]) if st.session_state["room"] in ROOMS else 0)
    if selected_room != st.session_state["room"]:
        st.session_state["room"] = selected_room
    capture.set_room(st.session_state["room"])

    st.divider()

    # Model status
    st.markdown("**🧠 Model**")
    if detector.is_model_ready():
        st.markdown('<span class="pill pill-ready">✓ YAMNet Ready</span>', unsafe_allow_html=True)
    else:
        st.markdown('<span class="pill pill-loading">⏳ Loading…</span>', unsafe_allow_html=True)
        st.caption("Downloading YAMNet once (~26 MB). Please wait.")

    st.markdown("")

    # Start / Stop
    st.markdown("**🎙️ Microphone**")
    is_running = capture.is_running()
    last_err = capture.get_last_error()

    if is_running:
        st.markdown('<span class="pill pill-live">● LIVE</span>', unsafe_allow_html=True)
        st.markdown("")
        if st.button("⏹  Stop Listening", key="btn_stop"):
            capture.stop()
            st.rerun()
    else:
        st.markdown('<span class="pill pill-idle">○ Idle</span>', unsafe_allow_html=True)
        st.markdown("")
        if st.button("▶  Start Listening", key="btn_start", type="primary"):
            if not detector.is_model_ready():
                st.warning("YAMNet is still loading. Please wait a moment.")
            else:
                capture.start()
                st.rerun()

    if last_err:
        st.error(f"⚠ Mic error: {last_err}")

    st.divider()

    # Privacy
    with st.expander("🔒 Privacy"):
        st.markdown("""
**No audio is ever saved.**
Only the sound label, confidence %, timestamp, and room tag are stored locally in `echotrace.db`.
No data leaves this device.
        """)

    # Monitored sounds
    with st.expander("📋 Monitored sounds"):
        for c in sorted(TARGET_CLASSES):
            st.caption(f"• {c}")

# ── MAIN ─────────────────────────────────────────────────────────────────────
st.markdown("# 🎧 EchoTrace")
st.markdown(f"Ambient sound memory assistant &nbsp;·&nbsp; Room: **{st.session_state['room']}**")
st.divider()

# ── Stats row ─────────────────────────────────────────────────────────────────
try:
    stats = database.get_event_stats()
except Exception:
    stats = {"total": 0, "today": 0, "top_sounds": []}

c1, c2, c3, c4 = st.columns(4)
c1.metric("🔔 Total Events", stats["total"])
c2.metric("📅 Today", stats["today"])
c3.metric("📍 Room", st.session_state["room"])
c4.metric("🎙️ Status", "LIVE" if capture.is_running() else "Idle")

st.divider()

# ── Live feed (auto-refreshes every 3 s while listening) ─────────────────────
@st.fragment(run_every=3 if capture.is_running() else None)
def live_feed():
    col_feed, col_stats = st.columns([3, 2], gap="large")

    with col_feed:
        st.markdown("### 🔴 Live Feed")

        recent = capture.get_recent_events(n=8)
        if not recent:
            # Fall back to DB
            recent = database.get_recent_events(limit=8)

        if recent:
            for ev in recent:
                conf_pct = f"{ev['confidence'] * 100:.0f}%"
                ts = ev["timestamp"]
                # Convert UTC to a nicer format
                try:
                    dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    ts_disp = dt.strftime("%H:%M:%S")
                except Exception:
                    ts_disp = ts

                st.markdown(f"""
<div class="ev-card">
  <span class="ev-conf">{conf_pct}</span>
  <div class="ev-title">🔊 {ev['sound_class']}</div>
  <div class="ev-meta">🕐 {ts_disp} &nbsp;|&nbsp; 📍 {ev['room']}</div>
</div>""", unsafe_allow_html=True)
        else:
            if capture.is_running():
                st.info("👂 Listening… No sounds detected yet. Try making some noise!")
            else:
                st.info("No events recorded yet. Press **▶ Start Listening** in the sidebar.")

    with col_stats:
        st.markdown("### 📊 Session Counts")
        counts = capture.get_session_counts()
        if counts:
            df = pd.DataFrame(counts.items(), columns=["Sound", "Count"]).sort_values("Count", ascending=False).head(10)
            st.bar_chart(df.set_index("Sound"), color="#58a6ff")
        elif stats["top_sounds"]:
            st.caption("Historical top sounds:")
            df = pd.DataFrame(stats["top_sounds"]).rename(columns={"sound_class": "Sound", "n": "Count"})
            st.bar_chart(df.set_index("Sound"), color="#58a6ff")
        else:
            st.caption("Session counts will appear here once sounds are detected.")

live_feed()

st.divider()

# ── Search ────────────────────────────────────────────────────────────────────
st.markdown("### 🔍 Search Sound Timeline")
s1, s2 = st.columns([4, 1])
with s1:
    query = st.text_input("Search", placeholder="e.g. door, keys, speech, cough…",
                          label_visibility="collapsed")
with s2:
    all_rooms = ["All Rooms"] + database.get_all_rooms()
    room_sel = st.selectbox("Room", all_rooms, label_visibility="collapsed")

room_filter = None if room_sel == "All Rooms" else room_sel

if query:
    results = database.search_events(query, room_filter=room_filter, limit=200)
    if results:
        df = pd.DataFrame(results).drop(columns=["id"], errors="ignore")
        df.columns = [c.replace("_", " ").title() for c in df.columns]
        st.dataframe(df, use_container_width=True, height=300)
        st.caption(f"Found **{len(results)}** result(s) for *'{query}'*")
    else:
        st.warning(f"No events found matching **'{query}'**.")
else:
    st.caption("Type a keyword above to search the full sound timeline.")

st.divider()

# ── Full log ──────────────────────────────────────────────────────────────────
with st.expander("📜 Full Event Log (last 100)"):
    all_events = database.search_events("", limit=100)
    if all_events:
        df_all = pd.DataFrame(all_events).drop(columns=["id"], errors="ignore")
        df_all.columns = [c.replace("_", " ").title() for c in df_all.columns]
        st.dataframe(df_all, use_container_width=True, height=350)
    else:
        st.caption("No events yet.")

# ── Footer ────────────────────────────────────────────────────────────────────
st.markdown("""
<div style="text-align:center; color:#484f58; font-size:0.78rem; margin-top:2rem; padding-top:1rem; border-top: 1px solid #21262d;">
  EchoTrace · All audio processed on-device · No data leaves this machine
</div>
""", unsafe_allow_html=True)
