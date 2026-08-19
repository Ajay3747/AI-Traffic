/*
 * ================================================================
 *        SMART AI TRAFFIC CONTROL SYSTEM
 *        ESP32 TRAFFIC SIGNAL CONTROLLER
 * ================================================================
 *
 * 4 TRAFFIC LIGHT MODULES
 *
 * NORTH:
 *   RED     -> GPIO16
 *   YELLOW  -> GPIO4
 *   GREEN   -> GPIO17
 *
 * SOUTH:
 *   RED     -> GPIO18
 *   YELLOW  -> GPIO13
 *   GREEN   -> GPIO19
 *
 * EAST:
 *   RED     -> GPIO21
 *   YELLOW  -> GPIO14
 *   GREEN   -> GPIO22
 *
 * WEST:
 *   RED     -> GPIO23
 *   YELLOW  -> GPIO27
 *   GREEN   -> GPIO25
 *
 * EMERGENCY:
 *   GPIO2
 *
 * ================================================================
 *
 * TRAFFIC LOGIC
 *
 * If NORTH is active:
 *
 *   NORTH = GREEN
 *   SOUTH = RED
 *   EAST  = RED
 *   WEST  = RED
 *
 * If SOUTH is active:
 *
 *   NORTH = RED
 *   SOUTH = GREEN
 *   EAST  = RED
 *   WEST  = RED
 *
 * If EAST is active:
 *
 *   NORTH = RED
 *   SOUTH = RED
 *   EAST  = GREEN
 *   WEST  = RED
 *
 * If WEST is active:
 *
 *   NORTH = RED
 *   SOUTH = RED
 *   EAST  = RED
 *   WEST  = GREEN
 *
 * Last 3 seconds:
 *
 *   ACTIVE ROAD = YELLOW
 *   OTHER ROADS = RED
 *
 * Emergency:
 *
 *   EMERGENCY ROAD = GREEN
 *   OTHER ROADS    = RED
 *
 * Backend unavailable for 5 seconds:
 *
 *   ALL ROADS = RED
 *
 * ================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>


// ================================================================
// 1. WIFI CONFIGURATION
// ================================================================

const char* WIFI_SSID = "vivo T3 5G";
const char* WIFI_PASSWORD = "Ajay#123";


// ================================================================
// 2. EXPRESS SERVER CONFIGURATION
// ================================================================
//
// IMPORTANT:
//
// Your laptop is now connected to a NEW Wi-Fi.
//
// Therefore 192.168.31.49 may no longer be correct.
//
// Run this on your laptop:
//
//     ipconfig
//
// Find:
//
//     Wireless LAN adapter Wi-Fi
//     IPv4 Address
//
// Example:
//
//     IPv4 Address : 192.168.43.123
//
// Then change SERVER_HOST to:
//
//     192.168.43.123:5001
//
// ================================================================

const char* SERVER_HOST = "10.93.224.165:5001";


// Express endpoint
const char* SIGNAL_ENDPOINT =
  "/api/signal/status";


// ================================================================
// 3. TIMING
// ================================================================

// Ask Express for the current signal state every second
const unsigned long POLL_INTERVAL_MS = 1000;

// HTTP timeout
const unsigned long HTTP_TIMEOUT_MS = 3000;

// If backend is unavailable for 5 seconds -> ALL RED
const unsigned long BACKEND_FAILSAFE_MS = 5000;

// Last 3 seconds of green -> YELLOW
const int YELLOW_WARNING_SECONDS = 3;

// Wi-Fi reconnect interval
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000;


// ================================================================
// 4. TRAFFIC LIGHT STRUCTURE
// ================================================================

struct TrafficLight {

  const char* name;

  int redPin;

  int yellowPin;

  int greenPin;
};


// ================================================================
// 5. TRAFFIC LIGHT PIN CONFIGURATION
// ================================================================

TrafficLight roads[] = {

  // Name       RED    YELLOW    GREEN

  { "North",    16,      4,       17 },

  { "South",    18,     13,       19 },

  { "East",     21,     14,       22 },

  { "West",     23,     27,       25 }
};


const int ROAD_COUNT =
  sizeof(roads) / sizeof(roads[0]);


// ================================================================
// 6. EMERGENCY INDICATOR
// ================================================================

const int EMERGENCY_PIN = 2;


// ================================================================
// 7. GLOBAL VARIABLES
// ================================================================

unsigned long lastPoll = 0;

unsigned long lastWifiReconnect = 0;

unsigned long lastSuccessfulBackendResponse = 0;


// Backend connection status
bool backendConnected = false;


// Backend simulation state
bool simulationRunning = false;

bool simulationFinished = false;

bool emergency = false;


// Current active road from backend
String activeRoad = "";


// Countdown received from backend
int timerRemaining = 0;


// ================================================================
// 8. FUNCTION DECLARATIONS
// ================================================================

void connectWiFi();

void maintainWiFi();

bool pollSignalStatus();

void applyTrafficState();

void setAllRed();

void setRoadRed(int index);

void setRoadYellow(int index);

void setRoadGreen(int index);

int findRoadIndex(const char* roadName);

void printBackendState();


// ================================================================
// 9. SETUP
// ================================================================

void setup() {

  Serial.begin(115200);

  delay(1000);


  Serial.println();
  Serial.println("================================================");
  Serial.println("       SMART AI TRAFFIC CONTROL SYSTEM");
  Serial.println("             ESP32 CONTROLLER");
  Serial.println("================================================");
  Serial.println();


  // --------------------------------------------------------------
  // Firmware information
  // --------------------------------------------------------------

  Serial.print("Firmware build: ");

  Serial.print(__DATE__);

  Serial.print(" ");

  Serial.println(__TIME__);


  Serial.print("WiFi SSID: ");

  Serial.println(WIFI_SSID);


  Serial.print("Backend: http://");

  Serial.print(SERVER_HOST);

  Serial.println(SIGNAL_ENDPOINT);


  Serial.println();


  // ==============================================================
  // CONFIGURE ALL TRAFFIC LIGHT PINS
  // ==============================================================

  for (int i = 0; i < ROAD_COUNT; i++) {

    pinMode(
      roads[i].redPin,
      OUTPUT
    );

    pinMode(
      roads[i].yellowPin,
      OUTPUT
    );

    pinMode(
      roads[i].greenPin,
      OUTPUT
    );
  }


  // ==============================================================
  // EMERGENCY PIN
  // ==============================================================

  pinMode(
    EMERGENCY_PIN,
    OUTPUT
  );

  digitalWrite(
    EMERGENCY_PIN,
    LOW
  );


  // ==============================================================
  // SAFE START
  // ALL TRAFFIC LIGHTS RED
  // ==============================================================

  Serial.println("Setting ALL TRAFFIC LIGHTS RED...");

  setAllRed();


  // ==============================================================
  // CONNECT TO WIFI
  // ==============================================================

  connectWiFi();


  // ==============================================================
  // START BACKEND FAILSAFE TIMER
  // ==============================================================

  lastSuccessfulBackendResponse = millis();


  Serial.println();
  Serial.println("ESP32 traffic controller ready.");
  Serial.println();

}


// ================================================================
// 10. MAIN LOOP
// ================================================================

void loop() {

  unsigned long now = millis();


  // ==============================================================
  // MAINTAIN WIFI
  // ==============================================================

  maintainWiFi();


  // ==============================================================
  // POLL BACKEND EVERY SECOND
  // ==============================================================

  if (
    now - lastPoll >=
    POLL_INTERVAL_MS
  ) {

    lastPoll = now;

    pollSignalStatus();
  }


  // ==============================================================
  // BACKEND FAILSAFE
  // ==============================================================

  if (
    now - lastSuccessfulBackendResponse >
    BACKEND_FAILSAFE_MS
  ) {

    backendConnected = false;

    Serial.println(
      "FAIL-SAFE: Backend unavailable -> ALL RED"
    );

    setAllRed();

    digitalWrite(
      EMERGENCY_PIN,
      LOW
    );

    // Do NOT use old backend state
    return;
  }


  // ==============================================================
  // APPLY CURRENT BACKEND STATE
  // ==============================================================

  applyTrafficState();
}


// ================================================================
// 11. CONNECT WIFI
// ================================================================

void connectWiFi() {

  Serial.println();

  Serial.print(
    "Connecting to WiFi: "
  );

  Serial.println(
    WIFI_SSID
  );


  WiFi.mode(WIFI_STA);


  // Helps with some phone hotspot connections
  WiFi.setSleep(false);


  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );


  unsigned long startTime =
    millis();


  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - startTime < 20000
  ) {

    delay(500);

    Serial.print(".");
  }


  Serial.println();


  if (
    WiFi.status() == WL_CONNECTED
  ) {

    Serial.println(
      "================================"
    );

    Serial.println(
      "WiFi CONNECTED!"
    );

    Serial.print(
      "ESP32 IP address: "
    );

    Serial.println(
      WiFi.localIP()
    );


    Serial.print(
      "Gateway: "
    );

    Serial.println(
      WiFi.gatewayIP()
    );


    Serial.print(
      "Signal strength: "
    );

    Serial.print(
      WiFi.RSSI()
    );

    Serial.println(
      " dBm"
    );


    Serial.print(
      "Backend: http://"
    );

    Serial.print(
      SERVER_HOST
    );

    Serial.println(
      SIGNAL_ENDPOINT
    );


    Serial.println(
      "================================"
    );

  }

  else {

    Serial.println(
      "WiFi connection FAILED!"
    );

    Serial.println(
      "Check SSID and password."
    );
  }
}


// ================================================================
// 12. MAINTAIN WIFI
// ================================================================

void maintainWiFi() {

  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {

    return;
  }


  unsigned long now =
    millis();


  if (
    now - lastWifiReconnect >=
    WIFI_RECONNECT_INTERVAL_MS
  ) {

    lastWifiReconnect = now;


    Serial.println();

    Serial.println(
      "WiFi disconnected."
    );

    Serial.println(
      "Trying to reconnect..."
    );


    WiFi.disconnect();

    delay(100);


    WiFi.begin(
      WIFI_SSID,
      WIFI_PASSWORD
    );
  }
}


// ================================================================
// 13. POLL EXPRESS BACKEND
// ================================================================

bool pollSignalStatus() {

  // --------------------------------------------------------------
  // Check WiFi first
  // --------------------------------------------------------------

  if (
    WiFi.status() != WL_CONNECTED
  ) {

    backendConnected = false;

    Serial.println(
      "WiFi unavailable. Backend poll skipped."
    );

    return false;
  }


  // --------------------------------------------------------------
  // Create HTTP client
  // --------------------------------------------------------------

  HTTPClient http;


  // --------------------------------------------------------------
  // Build URL
  // --------------------------------------------------------------

  String url =
    String("http://") +
    SERVER_HOST +
    SIGNAL_ENDPOINT;


  Serial.print(
    "GET "
  );

  Serial.println(
    url
  );


  // --------------------------------------------------------------
  // Start HTTP
  // --------------------------------------------------------------

  http.begin(
    url
  );


  http.setTimeout(
    HTTP_TIMEOUT_MS
  );


  // --------------------------------------------------------------
  // Send GET request
  // --------------------------------------------------------------

  int httpCode =
    http.GET();


  // --------------------------------------------------------------
  // Connection error
  // --------------------------------------------------------------

  if (
    httpCode <= 0
  ) {

    Serial.print(
      "HTTP connection error: "
    );

    Serial.println(
      http.errorToString(
        httpCode
      )
    );


    backendConnected = false;


    http.end();


    return false;
  }


  // --------------------------------------------------------------
  // HTTP response
  // --------------------------------------------------------------

  Serial.print(
    "HTTP code: "
  );

  Serial.println(
    httpCode
  );


  // --------------------------------------------------------------
  // Wrong HTTP status
  // --------------------------------------------------------------

  if (
    httpCode != 200
  ) {

    Serial.print(
      "Backend returned HTTP "
    );

    Serial.println(
      httpCode
    );


    backendConnected = false;


    http.end();


    return false;
  }


  // --------------------------------------------------------------
  // Read JSON response
  // --------------------------------------------------------------

  String payload =
    http.getString();


  http.end();


  Serial.print(
    "Backend response: "
  );

  Serial.println(
    payload
  );


  // --------------------------------------------------------------
  // Parse JSON
  // --------------------------------------------------------------

  JsonDocument doc;


  DeserializationError error =
    deserializeJson(
      doc,
      payload
    );


  if (
    error
  ) {

    Serial.print(
      "JSON parse failed: "
    );

    Serial.println(
      error.c_str()
    );


    backendConnected = false;


    return false;
  }


  // --------------------------------------------------------------
  // Check success
  // --------------------------------------------------------------

  bool success =
    doc["success"] | false;


  if (
    !success
  ) {

    Serial.println(
      "Backend returned success=false"
    );


    backendConnected = false;


    return false;
  }


  // --------------------------------------------------------------
  // Get state
  // --------------------------------------------------------------

  JsonObject state =
    doc["state"];


  if (
    state.isNull()
  ) {

    Serial.println(
      "ERROR: Backend response missing state!"
    );


    backendConnected = false;


    return false;
  }


  // ==============================================================
  // READ SIMULATION STATE
  // ==============================================================

  simulationRunning =
    state["isSimulating"] | false;


  simulationFinished =
    state["simulationFinished"] | false;


  emergency =
    state["emergency"] | false;


  // ==============================================================
  // READ ACTIVE ROAD
  // ==============================================================

  activeRoad =
    state["activeRoad"] | "";


  // ==============================================================
  // READ TIMER
  // ==============================================================

  timerRemaining =
    state["timerRemaining"] | 0;


  // ==============================================================
  // BACKEND HEALTHY
  // ==============================================================

  backendConnected = true;


  lastSuccessfulBackendResponse =
    millis();


  // ==============================================================
  // EMERGENCY INDICATOR
  // ==============================================================

  digitalWrite(
    EMERGENCY_PIN,
    emergency ? HIGH : LOW
  );


  // ==============================================================
  // PRINT STATE
  // ==============================================================

  printBackendState();


  return true;
}


// ================================================================
// 14. APPLY TRAFFIC STATE
// ================================================================

void applyTrafficState() {

  // ==============================================================
  // BACKEND NOT CONNECTED
  // ==============================================================

  if (
    !backendConnected
  ) {

    setAllRed();

    return;
  }


  // ==============================================================
  // SIMULATION NOT RUNNING
  // ==============================================================

  if (
    !simulationRunning
  ) {

    Serial.println(
      "Simulation stopped -> ALL RED"
    );

    setAllRed();

    digitalWrite(
      EMERGENCY_PIN,
      LOW
    );

    return;
  }


  // ==============================================================
  // SIMULATION FINISHED
  // ==============================================================

  if (
    simulationFinished
  ) {

    Serial.println(
      "Simulation finished -> ALL RED"
    );

    setAllRed();

    digitalWrite(
      EMERGENCY_PIN,
      LOW
    );

    return;
  }


  // ==============================================================
  // NO ACTIVE ROAD
  // ==============================================================

  if (
    activeRoad.length() == 0
  ) {

    Serial.println(
      "No active road -> ALL RED"
    );

    setAllRed();

    return;
  }


  // ==============================================================
  // FIND ACTIVE ROAD
  // ==============================================================

  int roadIndex =
    findRoadIndex(
      activeRoad.c_str()
    );


  if (
    roadIndex < 0
  ) {

    Serial.print(
      "ERROR: Unknown road: "
    );

    Serial.println(
      activeRoad
    );

    setAllRed();

    return;
  }


  // ==============================================================
  // EMERGENCY MODE
  // ==============================================================

  if (
    emergency
  ) {

    Serial.print(
      "🚑 EMERGENCY -> "
    );

    Serial.print(
      activeRoad
    );

    Serial.println(
      " GREEN"
    );


    // Active road GREEN
    // All other roads RED

    setRoadGreen(
      roadIndex
    );

    return;
  }


  // ==============================================================
  // YELLOW MODE
  // ==============================================================

  if (
    timerRemaining > 0 &&
    timerRemaining <=
    YELLOW_WARNING_SECONDS
  ) {

    Serial.print(
      "🟡 YELLOW -> "
    );

    Serial.print(
      activeRoad
    );

    Serial.print(
      " | "
    );

    Serial.print(
      timerRemaining
    );

    Serial.println(
      " seconds remaining"
    );


    // Active road YELLOW
    // Other roads RED

    setRoadYellow(
      roadIndex
    );

    return;
  }


  // ==============================================================
  // GREEN MODE
  // ==============================================================

  Serial.print(
    "🟢 GREEN -> "
  );

  Serial.print(
    activeRoad
  );

  Serial.print(
    " | "
  );

  Serial.print(
    timerRemaining
  );

  Serial.println(
    " seconds"
  );


  // Active road GREEN
  // Other roads RED

  setRoadGreen(
    roadIndex
  );
}


// ================================================================
// 15. ALL ROADS RED
// ================================================================
//
// Example when North is active:
//
// North -> RED OFF
// South -> RED ON
// East  -> RED ON
// West  -> RED ON
//
// setRoadGreen() then changes North to GREEN.
//
// ================================================================

void setAllRed() {

  for (
    int i = 0;
    i < ROAD_COUNT;
    i++
  ) {

    // RED ON
    digitalWrite(
      roads[i].redPin,
      HIGH
    );


    // YELLOW OFF
    digitalWrite(
      roads[i].yellowPin,
      LOW
    );


    // GREEN OFF
    digitalWrite(
      roads[i].greenPin,
      LOW
    );
  }
}


// ================================================================
// 16. ONE ROAD RED
// ================================================================

void setRoadRed(
  int index
) {

  if (
    index < 0 ||
    index >= ROAD_COUNT
  ) {

    return;
  }


  digitalWrite(
    roads[index].redPin,
    HIGH
  );


  digitalWrite(
    roads[index].yellowPin,
    LOW
  );


  digitalWrite(
    roads[index].greenPin,
    LOW
  );
}


// ================================================================
// 17. ONE ROAD YELLOW
// ================================================================
//
// Active road:
//
// RED    = OFF
// YELLOW = ON
// GREEN  = OFF
//
// Other 3 roads:
//
// RED    = ON
// YELLOW = OFF
// GREEN  = OFF
//
// ================================================================

void setRoadYellow(
  int index
) {

  if (
    index < 0 ||
    index >= ROAD_COUNT
  ) {

    return;
  }


  // --------------------------------------------------------------
  // SAFETY: FIRST MAKE EVERY ROAD RED
  // --------------------------------------------------------------

  setAllRed();


  // --------------------------------------------------------------
  // ACTIVE ROAD
  // --------------------------------------------------------------

  // RED OFF
  digitalWrite(
    roads[index].redPin,
    LOW
  );


  // YELLOW ON
  digitalWrite(
    roads[index].yellowPin,
    HIGH
  );


  // GREEN OFF
  digitalWrite(
    roads[index].greenPin,
    LOW
  );
}


// ================================================================
// 18. ONE ROAD GREEN
// ================================================================
//
// Active road:
//
// RED    = OFF
// YELLOW = OFF
// GREEN  = ON
//
// Other 3 roads:
//
// RED    = ON
// YELLOW = OFF
// GREEN  = OFF
//
// ================================================================

void setRoadGreen(
  int index
) {

  if (
    index < 0 ||
    index >= ROAD_COUNT
  ) {

    return;
  }


  // --------------------------------------------------------------
  // SAFETY: FIRST MAKE EVERY ROAD RED
  // --------------------------------------------------------------

  setAllRed();


  // --------------------------------------------------------------
  // ACTIVE ROAD
  // --------------------------------------------------------------

  // RED OFF
  digitalWrite(
    roads[index].redPin,
    LOW
  );


  // YELLOW OFF
  digitalWrite(
    roads[index].yellowPin,
    LOW
  );


  // GREEN ON
  digitalWrite(
    roads[index].greenPin,
    HIGH
  );
}


// ================================================================
// 19. FIND ROAD INDEX
// ================================================================

int findRoadIndex(
  const char* roadName
) {

  if (
    roadName == nullptr
  ) {

    return -1;
  }


  if (
    strlen(roadName) == 0
  ) {

    return -1;
  }


  for (
    int i = 0;
    i < ROAD_COUNT;
    i++
  ) {

    if (
      strcmp(
        roads[i].name,
        roadName
      ) == 0
    ) {

      return i;
    }
  }


  return -1;
}


// ================================================================
// 20. PRINT BACKEND STATE
// ================================================================

void printBackendState() {

  Serial.println();

  Serial.println(
    "------------- BACKEND STATE -------------"
  );


  Serial.print(
    "Backend: "
  );

  Serial.println(
    backendConnected ?
    "CONNECTED" :
    "DISCONNECTED"
  );


  Serial.print(
    "Simulation: "
  );

  Serial.println(
    simulationRunning ?
    "RUNNING" :
    "STOPPED"
  );


  Serial.print(
    "Active Road: "
  );


  if (
    activeRoad.length() > 0
  ) {

    Serial.println(
      activeRoad
    );

  }

  else {

    Serial.println(
      "NONE"
    );
  }


  Serial.print(
    "Timer: "
  );

  Serial.print(
    timerRemaining
  );

  Serial.println(
    " seconds"
  );


  Serial.print(
    "Emergency: "
  );

  Serial.println(
    emergency ?
    "YES" :
    "NO"
  );


  Serial.print(
    "Finished: "
  );

  Serial.println(
    simulationFinished ?
    "YES" :
    "NO"
  );


  Serial.println(
    "------------------------------------------"
  );
}