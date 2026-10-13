# AI Smart Traffic Control System — Project Documentation

A four-tier prototype that replaces fixed-time traffic signals with camera-driven vehicle counts and gives ambulances real-time green-light priority based on live GPS — spanning a computer-vision service, an orchestration backend, a driver-facing web app, and physical ESP32-controlled signal hardware.

---

## 1. Overview

Two problems are being solved at once, using genuinely different techniques:

1. **Adaptive signal timing.** Instead of giving every road a fixed 30-second green regardless of traffic, a camera feed per road is run through a vehicle detector, and the green-light duration is computed from how many vehicles are actually waiting.
2. **Emergency vehicle priority.** An ambulance driver's phone streams GPS to the backend. A geometry engine works out which road the ambulance is approaching from and how close it is, and pre-empts the signal to green for that road — independent of the camera system, and able to interrupt it at any point in the cycle.

A physical ESP32 microcontroller drives real LEDs standing in for a 4-way junction, so the whole loop — video in, decision made, light changes — is demonstrable on a breadboard rather than only in a browser.

---

## 2. System Architecture

Four independently-runnable components, each with one job:

```
CLIENTS
  Dashboard (App.jsx)              — upload video, watch simulation
  Ambulance console (AmbulancePage.jsx) — phone, GPS watchPosition
        │
        ▼
ORCHESTRATOR
  Express backend (server.js)      — signalState, ambulance priority, REST
        │
        ▼
AI SERVICE
  Flask (app.py + detect.py)       — YOLO + ByteTrack vehicle/ambulance detection
        │
HARDWARE
  ESP32 firmware                   — polls /api/signal/status → drives 13 LEDs
```

**Why split the AI service out from the backend?** YOLO inference is heavy, Python-native, and slow on CPU. Keeping it as a separate Flask process means the Express layer stays responsive for polling clients (the dashboard and the ESP32 both hit it every second) and can keep answering even if the AI service is down — via a mock-data fallback (see [Known Limitations](#7-known-limitations)).

---

## 3. Data Flow — How the Pieces Talk to Each Other

| Link | Protocol | Pattern |
|---|---|---|
| Dashboard ↔ Backend | REST/JSON, axios | Uploads video, requests analysis, then **polls** `/api/signal/status` every 1s to stay in sync |
| Backend ↔ AI service | REST/JSON, axios | Backend forwards video paths/frames to Flask; 15-minute timeout; falls back to mock data if Flask is unreachable |
| Backend ↔ ESP32 | HTTP GET, one-way | ESP32 **pulls** `/api/signal/status` every 1s — no push channel, no MQTT/WebSocket. Backend has no idea the ESP32 exists. |
| Ambulance phone ↔ Backend | REST/JSON, HTTPS | Browser Geolocation → `POST /api/ambulance/location` every 2s; HTTPS is mandatory because browsers refuse Geolocation on plain HTTP |

The elegant part of this design: the ESP32 never needs to know GPS exists. Ambulance priority and camera-based timing both just mutate the same `signalState` object on the backend — the firmware only ever reads "who's green right now."

---

## 4. Algorithms

### 4.1 Vehicle Detection & Tracking Pipeline
**File:** `ai/detect.py` → `analyze_video()`
**Purpose:** turn a raw traffic video into a reliable per-road vehicle count and an emergency flag.

1. **Model selection by class name** — loads a custom-trained model if one exists (recognises an "ambulance" class), otherwise falls back to base `yolov8n.pt` (COCO classes only — car/motorcycle/bus/truck, cannot flag emergencies). Class IDs are resolved by name, not fixed index, so either model works unchanged.
2. **Frame skipping** — only every 5th frame is run through the model (`FRAME_SKIP=5`), capped at 600 frames total — trades a little temporal resolution for CPU-feasible speed.
3. **Detection + tracking** — each sampled frame goes through YOLO inference at a reduced 320px input size with ByteTrack (`persist=True`) assigning a stable ID to each vehicle across frames, at confidence ≥0.25 and IoU 0.45.
4. **Unique counting via a virtual line** (see 4.2).
5. **Multi-frame ambulance confirmation** (see 4.3).
6. **Thread safety** — a global lock serializes concurrent requests so two videos analysed at once can't corrupt shared tracker state.

### 4.2 Counting-Line Deduplication
**Purpose:** count each vehicle exactly once, not once per frame it appears in.

A classic traffic-camera technique: an imaginary line is drawn across the frame (default at 60% of frame height, `COUNT_LINE_POSITION`). A tracked vehicle is added to the count on the *first* frame where its bounding-box centre crosses that line — subsequent frames of the same tracked ID are ignored. Without this, a car sitting in frame for 40 sampled frames would be counted 40 times; with it, ByteTrack's persistent ID plus the crossing check gives one count per physical vehicle.

### 4.3 Ambulance Confirmation (Video)
**Purpose:** stop one lucky misdetection from triggering a false emergency preemption.

A single frame classified as "ambulance" is not trusted. The *same tracked ID* must be classified as ambulance at ≥60% confidence for 3 consecutive processed frames (`AMBULANCE_CONFIRMATION_FRAMES`) before the system raises the emergency flag for that road. This is deliberately stricter than ordinary vehicle counting, since a false emergency preemption disrupts every other road's timing.

### 4.4 Adaptive Green-Time Formula
**Files:** `calculate_green_duration()` (Python, source of truth) and `getGreenSeconds()` (Node.js, fallback when Flask is unreachable) — duplicated intentionally so the demo degrades gracefully instead of breaking.

```
seconds = GREEN_BASE_SECONDS + GREEN_SECONDS_PER_VEHICLE × vehicle_count
seconds = clamp(seconds, GREEN_MIN_SECONDS, GREEN_MAX_SECONDS)

defaults → base=10, per_vehicle=0.6, min=15, max=60
```

A junction with 20 waiting vehicles gets 10 + 0.6×20 = 22s; a nearly-empty road gets clamped up to the 15s floor rather than an unusably short green; a jammed 100-vehicle road is capped at 60s so no other road starves.

### 4.5 Signal-Cycle State Machine
**File:** `server.js` → `tickSignal()`
**Purpose:** decide, every second, which road is green right now.

Runs on a `setInterval` tick once per second and drives one shared `signalState` object that every client polls:

1. **Emergency check first** — if any road's video analysis flagged an unserved emergency and it isn't already active, immediately jump to it with a fixed 15s window — this cuts the normal queue.
2. **Countdown** — otherwise decrement the active road's `timerRemaining` by one second.
3. **Advance on expiry** — once the timer hits zero, move to the next road in a fixed cyclic order: `North → East → South → West` (clockwise) or `North → West → South → East` (anticlockwise) — until every road has been served once, then mark the simulation finished.

### 4.6 Haversine Distance
**File:** `server.js` → `haversineDistanceMeters()`
**Purpose:** how far is the ambulance from the junction, in metres, from raw lat/lon.

```
a = sin²(Δφ/2) + cos(φ₁)·cos(φ₂)·sin²(Δλ/2)
c = 2·atan2(√a, √(1−a))
distance = R · c        // R = 6,371,000 m (Earth's mean radius)
```

Straight-line, not road-following distance — sufficient here because the trigger radius (tens of metres) is far smaller than any road curvature. Reused identically in the Python service for its own (legacy) proximity check.

### 4.7 Bearing Calculation & Road Matching
**File:** `server.js` → `bearingDegrees()` / `nearestRoadByBearing()`
**Purpose:** work out which of the 4 roads the ambulance is actually coming from.

Each road has a configured real-world compass bearing from the junction. Two independent methods feed one decision, chosen based on how reliable each signal currently is:

1. **Device-heading mode (preferred)** — once the phone is moving above 5 km/h, its GPS-reported heading is compared against each road's *inbound* bearing (outward bearing + 180°); a match within 45° wins. Heading is meaningless at low speed, so this mode is disabled below the threshold.
2. **Position-fallback mode** — computes the true compass bearing from the junction to the ambulance's current lat/lon (atan2 spherical bearing formula, not a naive Δlat/Δlon subtraction) and matches it to the nearest road bearing. Used when stationary or too far for heading to be trustworthy.
3. **Direction locking** — once a direction is chosen it's locked in, and low-confidence fallback fixes within 15m of the junction are ignored — this stops GPS jitter from flipping the "approaching road" back and forth near the intersection.

### 4.8 Priority Hysteresis Engine
**File:** `server.js` → `applyAmbulancePriority()`
**Purpose:** turn signal preemption on and off without flickering right at the boundary.

This is the single most reviewable piece of logic in the project — a textbook hysteresis (Schmitt trigger) pattern applied to a real-world control problem:

- While priority is **off**, only crossing *inward* past the trigger distance (default 50m) turns it on.
- While priority is **on**, only crossing *outward* past the exit distance (also 50m by default, independently configurable) turns it off.
- Using the same distance for both in this deployment is a choice, not a limitation of the mechanism — trigger and exit are separate constants specifically so they can be spread apart if flicker is observed at the boundary.

On trigger, the pre-emergency signal state is saved; on exit, it's restored and normal cycling resumes exactly where it left off.

### 4.9 GPS Watchdog Failsafe
**File:** `server.js` → `setInterval` watchdog
**Purpose:** never leave a road stuck green because a phone dropped connection.

If an emergency is active but no GPS update has arrived for 15 seconds (`GPS_TIMEOUT_MS`), the backend auto-clears the emergency itself rather than waiting for the phone to explicitly stop it. Mirrored on the client: the ambulance console shows a "GPS connection lost" banner under the same 15s threshold.

### 4.10 ESP32 Light-State Derivation
**File:** `esp32_traffic_light.ino` → `applyTrafficState()`
**Purpose:** decide what 13 LEDs should physically do, one second at a time.

The firmware carries no scheduling intelligence of its own — it is a pure follower of whatever `signalState` the backend hands it, evaluated in priority order:

1. **Fail-safe first** — if the backend hasn't answered for 10s, every light goes red, unconditionally.
2. **Not simulating / no active road** → all red.
3. **Emergency flag true** → active road jumps straight to green (skipping yellow) and the dedicated emergency LED lights up.
4. **Timer ≤ 3s remaining** → active road shows yellow, everything else red.
5. **Otherwise** → active road green, everything else red.

Also handles: WiFi auto-reconnect on a 5s retry loop, and verbose serial logging of every poll for debugging on the bench.

---

## 5. Tech Stack

| Component | Runtime | Framework | Key libraries |
|---|---|---|---|
| Backend | Node.js (ESM) | Express 4.19 | multer, axios, cors, dotenv, selfsigned |
| AI service | Python 3.10 | Flask 3.0 | ultralytics (YOLOv8/YOLO11), OpenCV, ByteTrack, numpy, lap, albumentations |
| Frontend | JavaScript/JSX | React 19 + Vite 8 | Tailwind CSS 4, framer-motion, lucide-react, axios |
| IoT | C++ (Arduino core) | ESP32 DevKit | WiFi.h, HTTPClient.h, ArduinoJson |

No database anywhere in the stack — `signalState` and `ambulanceState` are in-memory objects on the Express process, reset on restart. No WebSocket/MQTT — every real-time link is HTTP polling.

---

## 6. API Reference

### Backend — Express (`server.js`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/upload` | Upload one road's traffic video |
| POST | `/api/analyze` | Send all 4 road videos to the AI service; mock fallback if it's down |
| POST | `/api/analyze-frame` | Single live-webcam frame analysis |
| POST | `/api/signal/start` | Start the 4-way cycle with counts + direction |
| GET | `/api/signal/status` | Current signal state — polled by dashboard *and* ESP32 |
| POST | `/api/signal/reset` | Reset the cycle, keep direction |
| GET | `/api/health` | Health check |
| POST | `/api/ambulance/start` | Driver presses START EMERGENCY |
| POST | `/api/ambulance/location` | Phone posts a GPS fix (~every 2s) |
| POST | `/api/ambulance/stop` | Driver presses STOP EMERGENCY |
| GET | `/api/ambulance/status` | Current ambulance tracking/priority state |
| POST | `/api/emergency/test` | Trigger a demo emergency without a phone |
| POST | `/api/emergency/clear` | Clear a test/ambulance emergency |

### AI Service — Flask (`app.py`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/analyze` | Batch analyse 4 road videos → count/seconds/emergency each |
| POST | `/analyze-frame` | Single base64 frame → live count/emergency |
| POST | `/emergency/location` | Legacy direct-to-ESP32 GPS path — see Known Limitations |

---

## 7. Known Limitations

Naming your own gaps unprompted reads as engineering maturity, not weakness. These are the honest ones:

- **Mock-data resilience, not a real detector fallback.** If the Flask service is unreachable, the Express backend fabricates random vehicle counts so the demo keeps running. Good for uptime, but it means an "analysis succeeded" response doesn't always mean real inference happened — worth flagging explicitly in a live demo.
- **Ambulance class detection needs a trained model.** The custom 5-class YOLO model (car/motorcycle/bus/truck/ambulance) hasn't been trained yet — no images are in the dataset folder. Until then, detection silently falls back to base `yolov8n.pt`, which has no ambulance class at all, so video-based emergency detection can't actually fire. The GPS-based ambulance priority path is fully independent of this and works today.
- **A vestigial second emergency path.** Flask's `/emergency/location` computes its own proximity check against a single hardcoded junction and POSTs straight to a hardcoded ESP32 IP. The real ESP32 firmware has no HTTP server to receive that — it only polls outward. This route appears to be left over from an earlier design and isn't part of the live integration; call it out as future cleanup rather than let a reviewer assume it's a second live channel.
- **No persistence.** All state is in-memory on the Express process — a server restart silently forgets the current cycle and any in-flight ambulance emergency.
- **Minor threshold mismatch.** The frontend switches its simulated light to yellow at 7s remaining; the ESP32 firmware switches at 3s. Cosmetic only — the backend's `signalState`, the actual source of truth, doesn't carry a "yellow" concept at all, just a timer, so each client derives yellow independently and slightly differently.
- **No map UI.** The ambulance console shows raw latitude/longitude and a computed distance/bearing — no Leaflet/Mapbox visual, so a non-technical viewer has to trust the numbers.

---

## 8. Project Review Prep

### 8.1 Key Talking Points

What to lead with, roughly in the order a reviewer's attention will follow:

1. **Frame it as two systems sharing one state object.** Camera-based adaptive timing and GPS-based emergency priority are independent algorithmically, but both just write into the same `signalState` — which is why the ESP32 firmware never needed to know GPS exists. That's the architectural idea worth stating explicitly, not just showing.
2. **Lead the algorithms discussion with the hysteresis engine** (4.8) — it's the most "engineering," not just "plugged in a library," piece of logic in the project: a control-systems pattern (Schmitt trigger) applied to solve a real GPS-jitter problem, with a deliberate design decision (separate trigger/exit constants) baked in even though both currently equal 50m.
3. **Be precise about what YOLO buys you versus what the formula buys you.** YOLO + ByteTrack solves counting; the linear formula (4.4) is what actually makes the timing "adaptive" — a reviewer may ask you to justify the formula's coefficients, so have the base=10/per-vehicle=0.6/clamp=[15,60] numbers ready and be able to explain why clamping matters (fairness to other roads, minimum usable green).
4. **Explain the counting-line trick** (4.2) as the answer to "how do you avoid counting one car forty times" — it's a small idea but it's the kind of detail that shows you understand the pipeline rather than having called `model.track()` and stopped there.
5. **Own the limitations list proactively** — especially the untrained ambulance model and the legacy Flask→ESP32 path. State them as "next steps," not defects.
6. **Close on the resilience patterns**: fail-safe-to-red on lost backend connectivity, mock-fallback on lost AI service, GPS watchdog on lost phone connection. Three different failure modes, three different deliberate safe defaults — this is a good line to have ready if asked "what happens when X breaks."

### 8.2 Anticipated Q&A

**Q: Why not just use a simple timer-based signal, why involve YOLO at all?**
A: Fixed timers waste green time on empty roads and starve busy ones. Counting actual vehicles per cycle lets the green duration scale to real demand (10 + 0.6/vehicle, clamped 15–60s) instead of a static guess.

**Q: Why does the ambulance system use GPS instead of also using the camera to spot the ambulance?**
A: Both exist, deliberately as two independent detection paths. Camera-based ambulance detection depends on a trained model that doesn't exist yet and is inherently probabilistic; GPS priority works today, needs no ML, and is the one actually wired end-to-end from phone to ESP32.

**Q: How do you stop the light from flickering when the ambulance is right at the trigger boundary?**
A: Hysteresis — separate trigger-in and trigger-out distances (both 50m by default, but independently configurable), plus direction-locking so noisy GPS fixes near the junction can't flip which road is "approaching."

**Q: What happens if the ambulance's phone loses signal mid-emergency?**
A: A server-side watchdog clears the emergency automatically after 15 seconds of no GPS update, so a dropped connection can't leave a road stuck green indefinitely.

**Q: What happens if the AI service crashes during a live demo?**
A: The Express backend catches the failed call and returns randomized mock counts instead, so the signal cycle and UI keep functioning — worth disclosing this openly rather than letting a reviewer discover it.

**Q: Is this actually adaptive, or just a lookup table?**
A: It's a simple linear model, not a lookup table and not a learned policy — worth being upfront about. The honest framing: this is rule-based adaptive control (duration as a function of a live measurement), not reinforcement-learning-based signal optimization. That's a reasonable scope for a prototype, and a natural "future work" pointer if asked about extending it.

**Q: Why is there no database?**
A: The prototype's state (which road is green, is there an active emergency) is inherently transient — it doesn't need to survive a restart for the system to be correct. A database would matter for logging historical traffic patterns or emergency response times, which is a reasonable next step, not a current requirement.
