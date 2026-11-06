# EchoTrace 🎧

> **Privacy-first ambient sound memory assistant for dementia caregivers**

EchoTrace uses your device's microphone to detect familiar household sounds — keys jingling, drawers opening, taps running, footsteps — and logs them to a private local timeline. Caregivers and family members can search the timeline to reconstruct a loved one's day, review activity routines, and receive safety alerts, without any raw audio ever leaving the device.

---

## Table of Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Setup & Installation (Windows PowerShell & Cross-Platform)](#setup--installation)
4. [Running the Full Stack](#running-the-full-stack)
5. [Database Schema (SQLite)](#database-schema-sqlite)
6. [Intelligent Event Processing & Activity Engine](#intelligent-event-processing--activity-engine)
7. [Caregiver Alerts Management](#caregiver-alerts-management)
8. [Privacy Guarantee](#privacy-guarantee)
9. [Automated Testing](#automated-testing)
10. [Configuration & Troubleshooting](#configuration--troubleshooting)

---

## Features

- 🎙️ **Real-time sound detection** via [YAMNet](https://tfhub.dev/google/yamnet/1) (Google's AudioSet model).
- 🏠 **Room tagging** – label which room the device is in (Living Room, Kitchen, Bedroom, Bathroom, etc.).
- 🧠 **Activity Intelligence** – rule-based inference engine that clusters related sounds into daily routines (meal prep, hygiene, room transitions).
- 🚨 **Caregiver Alerts** – real-time detection and in-app acknowledgement for critical sounds (smoke alarms, fire alarms, glass breaking, impacts, crying).
- 🔍 **Searchable timeline** – query sounds by keyword, room, date, or source (real microphone vs. simulator).
- 📊 **Daily & Weekly Insights** – time-of-day distribution (Morning, Afternoon, Evening, Night) and room activity breakdown.
- 📥 **CSV Report Export** – download comprehensive caregiver reports for healthcare visits or family records.
- 🗃️ **Persistent SQLite Database** – WAL-mode database (`echotrace.db`) with migrations and indexed queries.
- 🔒 **100% On-Device & Privacy-First** – audio is analyzed in 1-second memory chunks; no continuous recordings or voice transcriptions are saved.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  React + TypeScript + Vite Frontend                              │
│  - Real microphone Web Audio API (16kHz mono chunking)           │
│  - Dark GitHub design (#0d1117, #161b22, #58a6ff)                │
│  - Live feed, frequency chart, activity routines, alerts         │
└─────────────────────────────────┬────────────────────────────────┘
                                  │ HTTP / REST
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Node.js / Express Server (server.ts :3000)                      │
│  ┌──────────────────────────────┐  ┌───────────────────────────┐ │
│  │ Event Processor Service      │  │ Activity Engine           │ │
│  │ (cooldown, temporal grouping)│  │ (rule-based daily routine)│ │
│  ├──────────────────────────────┤  ├───────────────────────────┤ │
│  │ Alert Manager Service        │  │ Report Generator          │ │
│  │ (Critical/High/Med/Low)      │  │ (insights, CSV export)    │ │
│  └──────────────┬───────────────┘  └─────────────┬─────────────┘ │
└─────────────────┼────────────────────────────────┼───────────────┘
                  │                                │
                  ▼                                ▼
┌─────────────────────────────────┐  ┌─────────────────────────────┐
│  Python AI Service (:5000)      │  │  Persistent SQLite          │
│  (ai-service/main.py)           │  │  (echotrace.db)             │
│  - YAMNet SavedModel / Hub      │  │  - events, activities       │
│  - AudioSet class mapping       │  │  - alerts, settings         │
└─────────────────────────────────┘  └─────────────────────────────┘
```

---

## Setup & Installation

### Prerequisites

| Requirement | Supported Version |
|---|---|
| **Node.js** | 18+ (Node 22 recommended) |
| **Python** | 3.9 – 3.11 |
| **Microphone** | Any system / browser-accessible microphone |

---

### Step 1: Clone / Navigate to Project

```powershell
cd EchoTrace
```

### Step 2: Install Node.js Dependencies

```powershell
npm install
```

### Step 3: Setup Python AI Service (Windows PowerShell)

```powershell
# Create virtual environment
python -m venv venv

# Activate virtual environment in PowerShell
.\venv\Scripts\Activate.ps1

# Upgrade pip and install Python AI dependencies
python -m pip install --upgrade pip
pip install -r ai-service\requirements.txt
```

> **Note on PowerShell Execution Policy:** If PowerShell reports script execution is disabled, run:
> `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`

---

## Running the Full Stack

### Method A: Single Command Launch (Recommended)

Running `npm run dev` starts the Express server, mounts the Vite frontend on port `3000`, and automatically launches the Python YAMNet AI Service as a managed background process:

```powershell
npm run dev
```

Then open **http://localhost:3000** in your web browser.

### Method B: Running Separately in Two Terminals

**Terminal 1 (Python YAMNet Service):**
```powershell
.\venv\Scripts\Activate.ps1
python ai-service\main.py
```

**Terminal 2 (Express Backend + Vite Frontend):**
```powershell
npm run dev
```

---

## Database Schema (SQLite)

The local SQLite database (`echotrace.db`) contains four indexed tables:

1. **`events`**:
   - `id`: Auto-incrementing primary key.
   - `sound_class`: AudioSet display name (e.g. `Keys jingling`, `Water tap, faucet`).
   - `confidence`: Confidence score (0.00 – 1.00).
   - `room`: Tagged location (e.g. `Kitchen`, `Living Room`).
   - `timestamp`: UTC ISO-8601 string.
   - `duration`: Measured sound duration in seconds (continuous events are grouped).
   - `source`: `'microphone'` (real audio) or `'simulator'` (demo trigger).
   - `session_id`: Client session identifier.

2. **`activities`**:
   - `id`: Primary key.
   - `activity_type`: Routine classification (`Kitchen Activity`, `Hygiene Routine`, `Room Transition`).
   - `description`: Plain-language explanation for caregivers.
   - `room`: Room where routine occurred.
   - `start_time` / `end_time`: Time window of activity.
   - `confidence`: Aggregate confidence score.
   - `related_event_ids`: JSON array of contributing sound events.

3. **`alerts`**:
   - `id`: Primary key.
   - `event_id`: Reference to triggering sound event.
   - `alert_type`: Alert name (e.g., `Smoke Detector Activated`, `Glass Breaking`).
   - `severity`: `Critical`, `High`, `Medium`, or `Low`.
   - `description`: Actionable caregiver recommendation.
   - `timestamp`: Event occurrence time.
   - `acknowledged`: `0` (pending) or `1` (acknowledged).
   - `acknowledged_at`: Acknowledgement timestamp.
   - `source`: Real microphone or simulated.

4. **`settings`**:
   - Stores user preferences (`confidence_threshold`, `duplicate_cooldown_sec`, `activity_window_min`).

---

## Intelligent Event Processing & Activity Engine

- **Duplicate Cooldown**: Rapid identical sounds (e.g. repeated knocks) within a 4-second window are suppressed to prevent spamming the caregiver feed.
- **Continuous Grouping**: Continuous sounds (`Footsteps`, `Water tap`, `Shower`, `Vacuum cleaner`) occurring over consecutive audio chunks are merged into a single event with an updated duration (e.g. `duration: 15s`) and smoothed moving average confidence.
- **Activity Interpretation Engine**: Automatically clusters temporal sound sequences:
  - *Kitchen*: Water tap + Dishes + Coffee maker ➔ "Possible breakfast or beverage preparation."
  - *Bathroom*: Water tap + Toilet flush + Shower ➔ "Possible hygiene routine."
  - *Living Room / Hallway*: Door + Keys jingling + Footsteps ➔ "Possible arrival or room transition."

---

## Caregiver Alerts Management

High-urgency sounds trigger instant notifications:

| Sound Class | Alert Type | Severity | Default Action |
|---|---|---|---|
| `Smoke detector, smoke alarm` | Smoke Detector Activated | **Critical** | Immediate in-app banner & caregiver check |
| `Fire alarm` | Fire Alarm Triggered | **Critical** | Evacuation & safety confirmation |
| `Glass breaking` | Glass Breaking / Potential Shatter | **High** | Inspection to prevent injury |
| `Loud impacts / crash` | Loud Impact / Possible Fall | **High** | Fall risk check on resident |
| `Crying, sobbing` | Distress Vocalization | **Medium** | Comfort & anxiety check |

Caregivers can acknowledge alerts directly from the dashboard banner or the alerts table with one click.

---

## Privacy Guarantee

EchoTrace adheres to strict privacy-first principles:
1. **Zero Continuous Recording**: No audio files, voice clips, or conversations are ever stored on disk.
2. **Ephemeral Memory Processing**: Audio is processed in 1-second floating-point memory buffers and immediately discarded after classification.
3. **No Voice Transcription**: The system classifies acoustic sound signatures only; speech content is never transcribed or monitored.
4. **Local Database**: All logs are saved strictly to the local `echotrace.db` file under your control.

---

## Automated Testing

Run the automated integration and service test suite:

```powershell
npm test
```

The test suite validates:
- SQLite connection, migrations, and schema creation.
- Confidence threshold filtering (< 0.40 rejected).
- Duplicate event suppression during cooldown.
- Continuous footsteps/tap grouping into ongoing events.
- Caregiver alert generation and acknowledgement.
- Rule-based activity routine interpretation.
- Dashboard analytics and CSV report generation.

---

## Troubleshooting

| Problem | Cause | Solution |
|---|---|---|
| `Microphone not accessible` | Browser blocked mic permission or HTTP iframe | Allow mic permission in browser address bar; run on `localhost` or HTTPS |
| `Connecting YAMNet...` | Python service starting or downloading model | Wait a few seconds for model initialization; check port `5000` |
| `npm test fails` | Database locked or file permissions | Close any open SQLite viewers and re-run `npm test` |
| `Port 3000 in use` | Another dev server is running | Kill the existing Node process or set `PORT=3001` in `.env` |
