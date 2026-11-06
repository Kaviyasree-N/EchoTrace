# EchoTrace – Step-by-Step Demonstration & Evaluation Guide

This guide provides evaluators, project reviewers, and professors with a structured walkthrough of **EchoTrace**'s capabilities.

---

## 1. Prerequisites for Evaluation

1. Clone or download the repository to your machine.
2. Ensure Node.js (version 18+ or 22) is installed.
3. Open a terminal in the project directory:
   ```bash
   npm install
   npm run dev
   ```
4. Open **`http://localhost:3000`** in Google Chrome, Microsoft Edge, or Mozilla Firefox.

---

## 2. Evaluation Walkthrough Scenarios

### Scenario 1: Initial Dashboard Inspection & Health Overview
* **Objective:** Verify user interface structure, database connectivity, and background model health.
* **Steps:**
  1. Observe the top navigation bar:
     * **EchoTrace · Sound Memory** branding.
     * System status indicators: AI Inference Engine badge, active client session pill, room selector, and Settings button.
  2. Notice the summary metrics cards:
     * **Total Events Logged**
     * **Events Today**
     * **Inferred Activities Count**
     * **Pending Alerts Count**
  3. Verify that initial sample history from `echotrace.db` (seeded during initialization) renders in the **Recent Events** feed and **Inferred Activities** timeline.

---

### Scenario 2: Quick Sound Simulator & Critical Alert Workflow
* **Objective:** Test sound event classification, temporal cooldown suppression, caregiver alert generation, and acknowledgement.
* **Steps:**
  1. In the left sidebar, locate the **⚡ Sound Simulator (Living Room)** panel.
  2. Click **🚨 Smoke alarm**:
     * **Observation:** A prominent red **CRITICAL** alert banner appears at the top of the Caregiver Alerts panel reading *"CRITICAL: Smoke detector alarm sound detected in Living Room (⚡ Simulated)"*.
     * The unacknowledged alert counter increments by 1.
     * An event entry tagged with `⚡ Simulated` is added to the Recent Events feed.
  3. Click **🪟 Glass breaking**:
     * **Observation:** A yellow **HIGH** alert banner appears for potential shatter/impact.
  4. Test **Duplicate Cooldown Suppression**:
     * Rapidly click **🚪 Door knock** three times in 1 second.
     * **Observation:** Only the first knock creates a new event; subsequent clicks within the 4-second cooldown are suppressed to keep the caregiver log uncluttered.
  5. Test **Alert Acknowledgement**:
     * Click the **✓ Acknowledge** button on the Glass Breaking alert.
     * **Observation:** The alert row updates with a green acknowledged badge and timestamp.
     * Click **✓ Ack All** to acknowledge all remaining pending alerts in one atomic operation.

---

### Scenario 3: Real-Time AudioWorklet Microphone Monitoring
* **Objective:** Test live audio capture, hardware-agnostic 16 kHz resampling, and acoustic sound detection.
* **Steps:**
  1. In the room selector dropdown, select **Kitchen**.
  2. Click the green **▶ Start Listening** button.
  3. When the browser prompts *"Allow EchoTrace to use your microphone?"*, click **Allow**.
  4. **Observation:**
     * The listening button turns into a pulsing red **⏹ Stop Listening** control.
     * The **Sound Level Meter** reacts visually in real-time as you speak, clap, or snap your fingers.
  5. Speak aloud for 3–5 seconds:
     * **Observation:** Within 1–2 seconds, a `Speech` event appears in the Recent Events log with room set to Kitchen and source marked as `🎙️ Mic`.
  6. Click **⏹ Stop Listening**:
     * **Observation:** Ambient monitoring stops cleanly, the level meter returns to 0, and the audio stream is released.

---

### Scenario 4: Activity Intelligence Routine Inference
* **Objective:** Demonstrate how the rule-based engine clusters related temporal sounds into daily living routines.
* **Steps:**
  1. In the sidebar room selector, select **Kitchen**.
  2. In the Sound Simulator, trigger:
     * **💧 Water tap**
     * **☕ Coffee maker**
     * **🍽️ Dishes & pans**
  3. Look at the **🧠 Inferred Activities** panel:
     * **Observation:** The Activity Engine clusters these events into a **Kitchen Activity** routine: *"Possible breakfast or beverage preparation detected with water running, coffee maker, and dishes."*
  4. Change room to **Bathroom** and trigger **💧 Water tap** $\rightarrow$ notice the activity engine updates with a **Personal Hygiene Routine**.

---

### Scenario 5: Centralized Settings Management & SQLite Persistence
* **Objective:** Verify dynamic parameter adjustment and persistence across browser reloads.
* **Steps:**
  1. Click **⚙️ Settings** in the top navigation bar.
  2. In the **Sound Detection** tab:
     * Move the **Minimum Confidence Threshold** slider from 40% to **65%**.
  3. In the **Caregiver Alerts** tab:
     * Toggle **🔊 Caregiver Melodic Alert Chime** to **ON**.
     * Click **▶ Preview Chime** to listen to the synthesized E5 $\rightarrow$ A5 bell sequence.
     * Click **🔔 Test Desktop Notification** (grant permission if prompted) to verify native OS desktop banner dispatch.
  4. Click **Save Settings** $\rightarrow$ observe the green confirmation toast *"✓ Settings saved successfully to SQLite database"*.
  5. **Hard-refresh the browser tab (Ctrl+F5 or Cmd+Shift+R).**
  6. Re-open **⚙️ Settings** $\rightarrow$ confirm threshold is still **65%** and chime is still **ON**.

---

### Scenario 6: Multi-Tab Client Session Isolation
* **Objective:** Verify that independent browser tabs maintain isolated sessions without data pollution.
* **Steps:**
  1. Copy the URL `http://localhost:3000` and open it in a **second browser tab**.
  2. Inspect the **Session:** badge in Tab 1 vs Tab 2:
     * **Observation:** Each tab displays a **distinct unique session ID** (e.g. `c827b5e8…` vs `4f91a2bc…`).
  3. In Tab 2, trigger **🔑 Keys jingling** using the Sound Simulator.
  4. In Tab 1, expand the **Search & Filter Log** $\rightarrow$ set the Session filter to **Current Tab**:
     * **Observation:** Tab 1 displays only its own events.
     * Switch the Session filter to **All Sessions** $\rightarrow$ Tab 1 displays events from both tabs.

---

### Scenario 7: Caregiver Reporting & CSV Export
* **Objective:** Export records for medical appointments or family reviews.
* **Steps:**
  1. In the top right of the Recent Events panel, click **📥 Export CSV**.
  2. Open the downloaded file in Excel, Google Sheets, or Notepad:
     * **Observation:** The CSV report contains three structured sections:
       1. **EchoTrace Sound Events Log** (timestamp, room, sound class, confidence, duration, source, session).
       2. **Inferred Daily Activities** (routine, description, room, start/end timestamps, confidence).
       3. **Caregiver Alerts Summary** (alert type, severity, description, acknowledgement status).
