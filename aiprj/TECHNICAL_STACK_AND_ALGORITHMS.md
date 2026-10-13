# Smart Traffic Control System
## Technical Stack and Algorithms

## 1. Project Summary

The Smart Traffic Control System is a four-part prototype that combines computer vision, adaptive traffic-signal control, GPS-based ambulance priority, and ESP32 hardware control.

The system supports two main workflows:

1. **Adaptive traffic control:** traffic videos are analyzed to count vehicles on each road. Green-light duration is calculated from the traffic demand.
2. **Ambulance priority:** an ambulance phone sends GPS coordinates to the backend. The backend identifies the approaching road and temporarily gives that road signal priority.

---

## 2. Technical Stack

### 2.1 Frontend

- **Language:** JavaScript and JSX
- **Framework:** React 19
- **Build tool and development server:** Vite
- **Styling:** Tailwind CSS and project CSS files
- **UI and animation:** Framer Motion and Lucide React
- **HTTP client:** Axios
- **Browser APIs:** Geolocation API for ambulance tracking
- **Transport:** HTTPS during development so mobile browsers can use geolocation

Main frontend views:

- `App.jsx`: traffic-control dashboard and video-analysis workflow
- `AmbulancePage.jsx`: ambulance driver console and GPS tracking
- `TrafficControlPage.jsx`: signal-control and monitoring interface

### 2.2 Backend

- **Runtime:** Node.js
- **Module system:** ECMAScript Modules (ESM)
- **Framework:** Express 4
- **HTTP client:** Axios
- **File upload:** Multer
- **Cross-origin support:** CORS
- **Configuration:** dotenv
- **Local HTTPS:** selfsigned certificate support
- **State storage:** in-memory JavaScript objects
- **Default HTTP port:** `5001`
- **Default HTTPS port:** `5443`

The backend is the central coordinator. It receives frontend requests, forwards analysis jobs to Flask, maintains signal and ambulance state, and serves the state to the dashboard and ESP32.

### 2.3 AI and Computer Vision Service

- **Language:** Python
- **Web framework:** Flask
- **Computer vision:** OpenCV
- **Object detection:** Ultralytics YOLO
- **Object tracking:** ByteTrack through YOLO tracking
- **Numerical processing:** NumPy
- **Cross-origin support:** Flask-CORS
- **Default port:** `5000`
- **Model:** `yolov8n.pt`, with support for a custom trained model when available

The AI service analyzes uploaded videos or individual frames and returns vehicle counts, detected classes, emergency status, and calculated green duration.

### 2.4 IoT Hardware

- **Microcontroller:** ESP32 DevKit
- **Language:** C++ with the Arduino framework
- **Network library:** `WiFi.h`
- **HTTP library:** `HTTPClient.h`
- **JSON parsing:** `ArduinoJson`
- **Output:** LEDs representing the four-way traffic signal and emergency status

The ESP32 periodically polls the backend. It does not calculate traffic timing itself; it follows the signal state supplied by the backend.

### 2.5 Communication and Data Formats

- **Frontend to backend:** REST over JSON and multipart file upload
- **Backend to AI service:** REST over JSON and video/frame requests
- **ESP32 to backend:** HTTP polling and JSON responses
- **Ambulance phone to backend:** HTTPS REST requests containing GPS data
- **Real-time approach:** periodic polling, not WebSockets or MQTT

---

## 3. System Architecture

```text
Traffic Dashboard / Ambulance Phone
              |
              v
      Express Backend API
       (state + decisions)
          /          \
         v            v
   Flask AI API      ESP32
 (YOLO + OpenCV)  (signal LEDs)
```

The Express backend is the source of truth for the current signal state. Both adaptive traffic timing and ambulance priority update that shared state. The ESP32 only needs to read the resulting state.

---

## 4. Algorithms Used

### 4.1 YOLO Object Detection

YOLO identifies vehicles in each processed video frame. The detector can identify common vehicle classes such as cars, motorcycles, buses, and trucks. A custom model can additionally provide an ambulance class.

Important detection settings include:

- Confidence threshold: approximately `0.25`
- IoU threshold: approximately `0.45`
- Inference image size: approximately `320` pixels
- Optional frame skipping to reduce CPU usage

The model is loaded once and reused to reduce startup and inference overhead.

### 4.2 ByteTrack Object Tracking

Detection alone can count the same vehicle repeatedly in consecutive frames. ByteTrack assigns a persistent tracking ID to detected objects across frames.

The system uses the tracking ID to:

- Follow a vehicle across sampled frames
- Determine when it crosses the counting line
- Prevent duplicate vehicle counts
- Track ambulance detections over multiple frames

### 4.3 Virtual Counting-Line Algorithm

A virtual line is placed across each traffic-camera frame, normally around 60% of the frame height.

For every tracked vehicle:

1. Calculate the center point of its bounding box.
2. Compare the center point with its previous position.
3. Detect whether the center crossed the virtual line.
4. Add the tracking ID to the counted set if it crossed and has not been counted before.

This ensures that one physical vehicle contributes one count instead of being counted once per frame.

### 4.4 Multi-Frame Ambulance Confirmation

A single ambulance classification may be a false detection. To reduce false emergency triggers, the same tracked object must satisfy the ambulance confidence rule for multiple consecutive processed frames.

The confirmation process is:

1. Detect an object as an ambulance.
2. Store its tracking ID and consecutive confirmation count.
3. Increase the count only when the same ID remains confirmed.
4. Raise the emergency flag after the configured confirmation threshold is reached.

This is stricter than ordinary vehicle counting because a false emergency priority request affects the whole junction.

### 4.5 Adaptive Green-Light Calculation

The green time is calculated from the number of vehicles detected on a road:

```text
raw_green_seconds = base_seconds + seconds_per_vehicle * vehicle_count
final_green_seconds = clamp(raw_green_seconds, minimum_seconds, maximum_seconds)
```

The current design uses values similar to:

```text
base_seconds = 10
seconds_per_vehicle = 0.6
minimum_seconds = 15
maximum_seconds = 60
```

For example, with 20 vehicles:

```text
10 + (0.6 * 20) = 22 seconds
```

The minimum prevents unusably short green phases. The maximum prevents one congested road from blocking all other roads indefinitely.

### 4.6 Traffic Signal State Machine

The backend runs a one-second control tick. The state machine follows this priority order:

1. Check whether an emergency priority request is active.
2. If emergency priority is active, keep the ambulance road green for the configured emergency window.
3. Otherwise decrease the active road timer.
4. When the timer expires, select the next road in the configured direction.
5. Mark the cycle complete after all roads have been served.

The normal road order is based on the configured junction direction, such as:

```text
North -> East -> South -> West
```

The state machine is shared by the dashboard, backend APIs, and ESP32 output.

### 4.7 Haversine Distance Algorithm

The Haversine formula calculates the straight-line distance between the ambulance and the junction using latitude and longitude.

```text
a = sin^2(delta_latitude / 2)
    + cos(latitude_1) * cos(latitude_2)
    * sin^2(delta_longitude / 2)

c = 2 * atan2(sqrt(a), sqrt(1 - a))
distance = Earth_radius * c
```

The Earth radius is approximately `6,371,000` metres. The result is used to decide when the ambulance enters or exits the signal-priority zone.

### 4.8 Bearing and Road-Matching Algorithm

The backend determines which road the ambulance is approaching from using compass direction.

It supports two modes:

1. **Device-heading mode:** use the phone's GPS heading when the ambulance is moving above the configured minimum speed.
2. **Position-bearing mode:** calculate the bearing from the junction to the ambulance when the heading is unavailable or unreliable.

The calculated direction is compared with configured road bearings. The nearest matching road is selected when it is within the allowed angular tolerance.

### 4.9 Direction Locking

GPS measurements can move slightly between updates. Without protection, the selected road could change repeatedly near the junction.

Direction locking reduces this problem by:

- Locking the selected approaching road
- Ignoring small low-confidence changes near the junction
- Releasing the lock only when the emergency session ends or the configured exit condition is reached

### 4.10 Priority Hysteresis

The emergency system uses separate trigger and exit distances:

- **Trigger distance:** priority starts when the ambulance enters the zone.
- **Exit distance:** priority ends when the ambulance leaves the zone.

This is a hysteresis control algorithm. It prevents the signal from rapidly switching on and off when GPS readings fluctuate around a boundary.

When priority starts, the backend saves the previous signal state. When priority ends, it can restore the normal cycle.

### 4.11 GPS Watchdog Failsafe

The backend monitors the time since the last ambulance GPS update. If no update arrives within the configured timeout, the emergency state is cleared automatically.

This prevents a communication failure from leaving a road permanently selected for emergency priority.

### 4.12 ESP32 Fail-Safe Signal Logic

The ESP32 derives LED output from the backend response:

1. If the backend has not responded for the timeout period, set all roads to red.
2. If the system is not running, set all roads to red.
3. If emergency priority is active, set the priority road to green and turn on the emergency LED.
4. If the active timer is near expiry, show yellow on the active road.
5. Otherwise show green on the active road and red on all other roads.

The fail-safe-to-red behavior is important because a network failure must not leave an uncontrolled green signal active.

---

## 5. Important API Endpoints

### Express Backend

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Upload a road traffic video |
| `POST` | `/api/analyze` | Analyze uploaded road videos |
| `POST` | `/api/analyze-frame` | Analyze a single frame |
| `GET` | `/api/signal/status` | Read current signal state |
| `POST` | `/api/ambulance/start` | Start ambulance tracking |
| `POST` | `/api/ambulance/location` | Submit ambulance GPS data |
| `POST` | `/api/ambulance/stop` | Stop ambulance tracking |
| `GET` | `/api/ambulance/status` | Read ambulance state |
| `POST` | `/api/emergency/test` | Trigger demo emergency priority |
| `POST` | `/api/emergency/clear` | Clear emergency priority |

### Flask AI Service

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Check AI service health |
| `POST` | `/analyze` | Analyze traffic videos |
| `POST` | `/analyze-frame` | Analyze one encoded frame |

---

## 6. Design Decisions

- **REST polling:** simple to debug and suitable for the prototype's one-second state updates.
- **Separate Python AI service:** keeps Python computer-vision dependencies isolated from the Node.js API.
- **In-memory state:** reduces setup complexity for a demonstration system.
- **Adaptive timing with bounds:** balances responsiveness to traffic with fairness between roads.
- **GPS priority independent of video detection:** ambulance priority can work even before a custom ambulance detector is trained.
- **Fail-safe red:** provides a safer hardware behavior when connectivity is lost.

---

## 7. Current Limitations and Future Improvements

- State is stored in memory and is lost when the backend restarts.
- A trained custom ambulance model is required for reliable video-based ambulance detection.
- The current design does not include a production database or user authentication.
- GPS distance is straight-line distance rather than route distance on a road network.
- REST polling can be replaced with WebSockets or MQTT for larger deployments.
- A production deployment should use trusted TLS certificates rather than development self-signed certificates.
- Signal timing constants should be calibrated with real traffic data and tested at a real junction.
