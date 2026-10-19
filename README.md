# EchoTrace 🎧

> **Privacy-first ambient sound memory assistant for dementia caregivers**

EchoTrace uses your device's microphone to detect familiar household sounds — keys jingling, drawers opening, taps running — and logs them to a private local timeline. Caregivers and family members can search the timeline to reconstruct a loved one's day, without any audio ever leaving the device.

---

## Table of Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Setup & Installation](#setup--installation)
4. [Running the App](#running-the-app)
5. [Privacy Guarantee](#privacy-guarantee)
6. [Monitored Sound Classes](#monitored-sound-classes)
7. [Configuration](#configuration)
8. [Troubleshooting](#troubleshooting)

---

## Features

- 🎙️ **Real-time sound detection** via [YAMNet](https://tfhub.dev/google/yamnet/1) (Google's AudioSet model)
- 🏠 **Room tagging** – label which room the device is in
- 🔍 **Searchable timeline** – find sounds by keyword, room, or time range
- 📊 **Live session stats** – bar chart of detected sounds
- 🔒 **100% on-device** – no audio or data sent to any server
- 🗃️ **Local SQLite database** – human-readable, portable, no cloud dependency

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Streamlit UI  (app.py)                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Sidebar     │  │  Live Feed   │  │  Search / Log    │  │
│  │  Room / ctrl │  │  Last 5 evts │  │  SQLite query    │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
└─────────┼─────────────────┼───────────────────┼────────────┘
          │ start/stop      │ ring buffer        │
          ▼                 │                    ▼
┌───────────────────────┐   │        ┌───────────────────┐
│  AudioCapture thread  │───┘        │  database.py      │
│  (audio_capture.py)   │──────────▶│  echotrace.db     │
│  sounddevice 1s chunk │            └───────────────────┘
└──────────┬────────────┘
           │ float32 waveform
           ▼
┌───────────────────────┐
│  detector.py          │
│  YAMNet (TF-Hub)      │
│  AudioSet class map   │
└───────────────────────┘
```

---

## Setup & Installation

### Prerequisites

| Requirement | Version |
|---|---|
| Python | 3.9 – 3.11 |
| pip | latest |
| Microphone | any system microphone |

> **Windows users:** if `sounddevice` fails to install, install [PortAudio](http://www.portaudio.com/) first or use `conda install -c conda-forge portaudio`.

### 1. Clone / unzip the project

```bash
cd EchoTrace
```

### 2. (Recommended) Create a virtual environment

```bash
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

> The first run will download the YAMNet model (~26 MB) from TensorFlow Hub and the AudioSet class-map CSV (~50 KB) from GitHub. Both are cached locally after that.

---

## Running the App

```bash
streamlit run app.py
```

Then open **http://localhost:8501** in your browser.

### Quick-start guide

1. Select the **Current Room** in the sidebar.
2. Click **▶ Start Listening**.
3. The YAMNet model loads in the background (status shown in sidebar).
4. Once **YAMNet Ready** appears, detected sounds will stream into the Live Feed.
5. Use the **Search** box to look up past sounds.
6. Click **⏹ Stop Listening** when done.

---

## Privacy Guarantee

EchoTrace was designed with the following privacy principles:

| Principle | How it's implemented |
|---|---|
| **No audio storage** | Raw audio is processed in memory and discarded. Only the label, confidence %, timestamp, and room tag are saved. |
| **No cloud** | YAMNet runs locally on CPU/GPU. No API calls are made during capture. |
| **Local-only database** | `echotrace.db` is a plain SQLite file stored in the project directory. You own it. |
| **Open model** | YAMNet is an open-source Google model, publicly auditable. |
| **Transparent class list** | Only sounds in `TARGET_CLASSES` (see `config.py`) trigger a log entry. |

---

## Monitored Sound Classes

EchoTrace watches for these AudioSet categories (configurable in `config.py`):

**Doors & Access:** Door · Doorbell · Knock · Sliding door · Cupboard · Drawer · Keys jingling  
**Kitchen:** Frying · Water tap · Dishes · Microwave · Blender · Coffee maker  
**Movement:** Footsteps · Chair · Squeak · Zipper  
**Alerts:** Smoke alarm · Fire alarm · Alarm clock · Telephone · Ringtone  
**Human:** Cough · Sneeze · Crying · Laughter · Speech  
**Appliances:** Vacuum cleaner · Washing machine · Toilet flush · Shower  

---

## Configuration

Edit `config.py` to customise behaviour:

```python
SAMPLE_RATE = 16000          # Hz – must match YAMNet's expected input
CHUNK_DURATION = 1           # seconds per analysis window
CONFIDENCE_THRESHOLD = 0.4   # raise to reduce false positives (0–1)
TARGET_CLASSES = [...]        # add or remove AudioSet class names
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `No module named 'sounddevice'` | `pip install sounddevice` or install PortAudio |
| `PortAudio not found` | Windows: install from [portaudio.com](http://portaudio.com); macOS: `brew install portaudio` |
| YAMNet model download hangs | Check internet connection; model is ~26 MB |
| No sounds detected | Lower `CONFIDENCE_THRESHOLD` in `config.py` (try 0.25) |
| High CPU usage | Normal during inference; use a machine with a GPU for lower load |
| `sqlite3.OperationalError` | Delete `echotrace.db` and restart to reinitialise the schema |

---

## Hackathon Notes

- **Built in:** Python 3.11
- **Model:** YAMNet (Google, Apache 2.0 licence)
- **Data:** AudioSet ontology (CC BY 4.0)
- **Storage:** SQLite (zero dependencies, portable)
- **UI framework:** Streamlit
