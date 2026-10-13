import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import selfsigned from 'selfsigned';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 5001;

const FLASK_API_URL =
  process.env.FLASK_API_URL || 'http://127.0.0.1:5000';

app.use(cors());
app.use(express.json());


// ============================================================
// UPLOADS
// ============================================================

const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use('/uploads', express.static(uploadsDir));


// ============================================================
// MULTER
// ============================================================

const storage = multer.diskStorage({

  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (req, file, cb) => {

    const road = req.body.road || 'unknown';

    const cleanRoad =
      road.toLowerCase().replace(/[^a-z0-9]/g, '');

    const uniqueSuffix =
      Date.now() + '-' + Math.round(Math.random() * 1e9);

    const ext =
      path.extname(file.originalname) || '.mp4';

    cb(
      null,
      `${cleanRoad}-${uniqueSuffix}${ext}`
    );
  }

});


const upload = multer({

  storage,

  fileFilter: (req, file, cb) => {

    const allowedTypes =
      /mp4|mkv|avi|mov|webm|ogg/i;

    const isVideo =
      allowedTypes.test(
        path.extname(file.originalname)
      ) ||
      allowedTypes.test(file.mimetype);

    if (isVideo) {
      cb(null, true);
    } else {
      cb(
        new Error('Only video files are allowed!'),
        false
      );
    }

  },

  limits: {
    fileSize: 1024 * 1024 * 1024
  }

});


// ============================================================
// UPLOAD VIDEO
// ============================================================

app.post('/api/upload', (req, res) => {

  upload.single('video')(
    req,
    res,
    (err) => {

      if (err) {

        console.error(
          'Upload error:',
          err
        );

        return res.status(400).json({
          success: false,
          message: err.message
        });
      }

      if (!req.file) {

        return res.status(400).json({
          success: false,
          message: 'No file uploaded'
        });
      }

      const fileUrl =
        `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

      const filePath =
        req.file.path;

      return res.status(200).json({

        success: true,

        url: fileUrl,

        path: filePath,

        filename: req.file.filename,

        road: req.body.road

      });

    }
  );

});


// ============================================================
// AI VIDEO ANALYSIS
// ============================================================

let analysisInProgress = false;


app.post('/api/analyze', async (req, res) => {

  const { videos } = req.body;

  if (
    !videos ||
    typeof videos !== 'object' ||
    Object.keys(videos).length === 0
  ) {

    return res.status(400).json({

      success: false,

      message:
        'No videos provided for analysis'

    });

  }


  if (analysisInProgress) {

    return res.status(409).json({

      success: false,

      message:
        'An analysis is already in progress. Please wait for it to finish before starting another.'

    });

  }


  analysisInProgress = true;


  try {

    console.log(
      'Sending analyze request to Flask API:',
      videos
    );


    const response = await axios.post(

      `${FLASK_API_URL}/analyze`,

      { videos },

      {
        timeout:
          15 * 60 * 1000
      }

    );


    return res.status(200).json({

      success: true,

      counts: response.data

    });

  }

  catch (error) {

    console.error(
      'Error connecting to Flask AI service:',
      error.message
    );


    console.warn(
      'Flask API is offline. Using mock analyzer fallback on Express.'
    );


    const mockCounts = {};


    for (const road of Object.keys(videos)) {

      const mockCount =
        Math.floor(Math.random() * 105) + 5;

      const seconds =
        Math.max(
          15,
          Math.min(
            60,
            10 + Math.floor(mockCount * 0.6)
          )
        );

      const emergency =
        mockCount > 30 &&
        Math.random() < 0.15;


      mockCounts[road] = {

        count: mockCount,

        seconds,

        emergency

      };

    }


    return res.status(200).json({

      success: true,

      counts: mockCounts,

      isMock: true,

      message:
        'Flask service unavailable; showing simulated analysis counts.'

    });

  }

  finally {

    analysisInProgress = false;

  }

});


// ============================================================
// LIVE FRAME ANALYSIS
// ============================================================

app.post('/api/analyze-frame', async (req, res) => {

  const { image, road } = req.body;


  if (!image) {

    return res.status(400).json({

      success: false,

      message: 'No image provided'

    });

  }


  try {

    const response =
      await axios.post(

        `${FLASK_API_URL}/analyze-frame`,

        {
          image,
          road
        }

      );


    return res.status(200).json({

      success: true,

      data: response.data

    });

  }

  catch (error) {

    console.warn(
      'Flask API is offline. Using mock frame analyzer fallback on Express.'
    );


    const mockCount =
      Math.floor(Math.random() * 12) + 2;


    const seconds =
      Math.max(
        15,
        Math.min(
          60,
          10 + Math.floor(mockCount * 0.6)
        )
      );


    const emergency =
      Math.random() < 0.1;


    return res.status(200).json({

      success: true,

      data: {

        count: mockCount,

        seconds,

        emergency

      },

      isMock: true

    });

  }

});


// ============================================================
// TRAFFIC SIGNAL SYSTEM
// ============================================================

const SIGNAL_ROADS = [
  'North',
  'South',
  'East',
  'West'
];


const defaultSignalState = () => ({

  isSimulating: false,

  activeRoad: null,

  timerRemaining: 0,

  servedRoads: [],

  simulationFinished: false,

  direction: 'clockwise',

  emergency: false,

  vehicleCounts: null

});


let signalState =
  defaultSignalState();

let signalTimer = null;
let adminSignalOverride = false;
let savedSignalStateBeforeAdmin = null;


// ============================================================
// GREEN TIME
// ============================================================

function getGreenSeconds(roadData) {

  if (!roadData) {
    return 15;
  }


  if (typeof roadData === 'object') {

    return Number(
      roadData.seconds
    ) || 15;

  }


  return Math.max(

    15,

    Math.min(

      60,

      10 +
      Math.floor(
        roadData * 0.6
      )

    )

  );

}


// ============================================================
// STOP SIGNAL TIMER
// ============================================================

function stopSignalTimer() {

  if (signalTimer) {

    clearInterval(
      signalTimer
    );

    signalTimer = null;

  }

}


// ============================================================
// SET ACTIVE ROAD
// ============================================================

function setActiveRoad(road) {

  signalState.activeRoad =
    road;


  signalState.emergency =
    !!signalState
      .vehicleCounts?.[road]
      ?.emergency;

}


// ============================================================
// NORMAL SIGNAL CYCLE
// ============================================================

function tickSignal() {

  const {
    vehicleCounts,
    activeRoad,
    servedRoads,
    direction
  } = signalState;


  // ----------------------------------------------------------
  // Emergency detected from YOLO
  // ----------------------------------------------------------

  const emergencyRoad =
    SIGNAL_ROADS.find(
      road =>
        vehicleCounts?.[road]?.emergency &&
        activeRoad !== road &&
        !servedRoads.includes(road)
    );


  if (emergencyRoad) {

    setActiveRoad(
      emergencyRoad
    );

    signalState.servedRoads =
      [
        ...servedRoads,
        emergencyRoad
      ];

    signalState.timerRemaining =
      15;

    return;

  }


  // ----------------------------------------------------------
  // Countdown
  // ----------------------------------------------------------

  if (
    signalState.timerRemaining > 0
  ) {

    signalState.timerRemaining -= 1;

    return;

  }


  // ----------------------------------------------------------
  // Direction sequence
  // ----------------------------------------------------------

  const sequence =
    direction === 'clockwise'

      ? [
          'North',
          'East',
          'South',
          'West'
        ]

      : [
          'North',
          'West',
          'South',
          'East'
        ];


  const currentIndex =
    sequence.indexOf(
      activeRoad
    );


  // ----------------------------------------------------------
  // Next road
  // ----------------------------------------------------------

  if (
    currentIndex !== -1 &&
    currentIndex + 1 <
      sequence.length
  ) {

    const nextRoad =
      sequence[
        currentIndex + 1
      ];


    setActiveRoad(
      nextRoad
    );


    signalState.servedRoads =
      [
        ...servedRoads,
        nextRoad
      ];


    signalState.timerRemaining =
      getGreenSeconds(
        vehicleCounts?.[nextRoad]
      );


  }

  else {

    signalState.isSimulating =
      false;

    signalState.activeRoad =
      null;

    signalState.emergency =
      false;

    signalState.simulationFinished =
      true;

    stopSignalTimer();

  }

}


// ============================================================
// START NORMAL SIGNAL CYCLE
// ============================================================

app.post(
  '/api/signal/start',
  (req, res) => {

    const {
      counts,
      direction
    } = req.body;


    if (
      !counts ||
      typeof counts !== 'object'
    ) {

      return res.status(400).json({

        success: false,

        message:
          'No vehicle counts provided'

      });

    }


    stopSignalTimer();


    signalState = {

      ...defaultSignalState(),

      isSimulating: true,

      servedRoads: [
        'North'
      ],

      direction:
        direction === 'anticlockwise'
          ? 'anticlockwise'
          : 'clockwise',

      vehicleCounts:
        counts

    };


    setActiveRoad(
      'North'
    );


    signalState.timerRemaining =
      getGreenSeconds(
        counts['North']
      );


    signalTimer =
      setInterval(
        tickSignal,
        1000
      );


    return res.status(200).json({

      success: true,

      state: signalState

    });

  }
);


// ============================================================
// SIGNAL STATUS
// ============================================================
//
// ESP32 polls this endpoint.
// Therefore emergency state is automatically received by ESP32.
// ============================================================

app.get(
  '/api/signal/status',
  (req, res) => {

    res.json({

      success: true,

      state: signalState,
      adminSignalOverride,
      ambulancePriority: ambulanceEmergencyActive

    });

  }
);


// ============================================================
// SIGNAL RESET
// ============================================================

app.post(
  '/api/signal/reset',
  (req, res) => {

    stopSignalTimer();


    const direction =
      signalState.direction;


    signalState = {

      ...defaultSignalState(),

      direction

    };


    res.json({

      success: true,

      state: signalState

    });

  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/api/health',
  (req, res) => {

    res.json({

      status: 'ok',

      service:
        'express-backend'

    });

  }
);



// ============================================================
// AMBULANCE GPS + EMERGENCY PRIORITY SYSTEM
// ============================================================
//
// Two distinct states, both exposed to the frontend and ESP32 chain:
//
//   emergencyRequested -- true from the moment the driver presses START
//     EMERGENCY until they press STOP (or the GPS watchdog times out).
//     Never gated by distance. This only starts phone GPS reporting.
//
//   signalPriority -- true only while the ambulance is close enough to
//     the junction to actually take over the lights. Computed purely
//     from GPS distance/direction on every location update.
//
// Flow: Ambulance Phone GPS -> POST /api/ambulance/location -> distance +
// heading -> signalPriority decision -> signalState.activeRoad/emergency
// -> GET /api/signal/status -> ESP32 -> physical LEDs. ESP32 needs no
// GPS and no changes; it already just reads activeRoad/emergency.
// ============================================================

// ------------------------------------------------------------
// CONFIGURATION
// ------------------------------------------------------------

// TRAFFIC_MODE=TEST points the whole ambulance-priority system at a
// convenient nearby "dummy" junction (DUMMY_JUNCTION_LAT/LON + numbered
// ROAD_BEARING_1..4) instead of the real one -- handy for a demo/rehearsal
// site that isn't the actual deployment location, without touching the
// real SIGNAL_LATITUDE/LONGITUDE/ROAD_BEARING_* config. Defaults to LIVE.
const TRAFFIC_MODE = (process.env.TRAFFIC_MODE || 'LIVE').toUpperCase();
const IS_TEST_MODE = TRAFFIC_MODE === 'TEST';

const SIGNAL_LOCATION = {
  signalId: 'SIG-001',
  name: process.env.SIGNAL_NAME || 'Prototype Junction',
  latitude:
    (IS_TEST_MODE
      ? Number.parseFloat(process.env.DUMMY_JUNCTION_LAT)
      : Number.parseFloat(process.env.SIGNAL_LATITUDE)) || 11.275600,
  longitude:
    (IS_TEST_MODE
      ? Number.parseFloat(process.env.DUMMY_JUNCTION_LON)
      : Number.parseFloat(process.env.SIGNAL_LONGITUDE)) || 77.583200,
};

// Real compass bearing (0-359, 0=true North, 90=East, ...) of each road as
// seen FROM the junction -- i.e. stand at the junction, face down the
// center of that road away from you, that's the bearing. Real
// intersections are rarely perfectly compass-aligned, so these default to
// exact cardinal (0/90/180/270) but should be overridden per-road for an
// accurate fix -- see ROAD_BEARING_* in .env for how to measure them.
// Everything below (position-fallback direction, heading-based direction)
// is computed relative to these, not assumed cardinal directions.
//
// In TEST mode the four roads are just numbered 1-4 (clockwise from
// whichever one you call "North" for the dummy site) rather than named,
// since a demo/rehearsal site has no real compass-aligned road names.
const ROAD_BEARINGS = IS_TEST_MODE
  ? {
      North: Number.parseFloat(process.env.ROAD_BEARING_1) || 0,
      East: Number.parseFloat(process.env.ROAD_BEARING_2) || 90,
      South: Number.parseFloat(process.env.ROAD_BEARING_3) || 180,
      West: Number.parseFloat(process.env.ROAD_BEARING_4) || 270,
    }
  : {
      North: Number.parseFloat(process.env.ROAD_BEARING_NORTH) || 0,
      East: Number.parseFloat(process.env.ROAD_BEARING_EAST) || 90,
      South: Number.parseFloat(process.env.ROAD_BEARING_SOUTH) || 180,
      West: Number.parseFloat(process.env.ROAD_BEARING_WEST) || 270,
    };

// Distance (meters) at which an in-progress emergency request converts
// into actual signal priority (green for the approach direction).
const SIGNAL_TRIGGER_DISTANCE =
  Number.parseFloat(process.env.SIGNAL_TRIGGER_DISTANCE) || 50;

// Distance (meters) priority is held out to once triggered. Evaluated
// only after priority has already turned on (see applyAmbulancePriority),
// so this is what keeps the green held while the ambulance is crossing
// and just past the junction, not just on the approach side. Raise this
// above SIGNAL_TRIGGER_DISTANCE for a longer hold-through-crossing window.
const SIGNAL_EXIT_DISTANCE =
  Number.parseFloat(process.env.SIGNAL_EXIT_DISTANCE) || 50;

// If no GPS update arrives for this long while an emergency is requested,
// the request is cleared automatically (dropped-connection failsafe).
const GPS_TIMEOUT_MS =
  Number.parseInt(process.env.GPS_TIMEOUT_MS, 10) || 15000;

// Heading tolerance in degrees either side of a road's inbound bearing
// (see ROAD_BEARINGS above).
const HEADING_TOLERANCE =
  Number.parseFloat(process.env.HEADING_TOLERANCE) || 45;

// Heading is only trusted above this speed -- GPS heading is unreliable
// (or simply absent) when a vehicle is stopped or crawling.
const MIN_HEADING_SPEED_KMH =
  Number.parseFloat(process.env.MIN_HEADING_SPEED_KMH) || 5;

// Below this distance (meters) from the junction, the position-fallback
// direction (comparing two nearly-identical lat/lon points) is dominated
// by ordinary GPS accuracy noise rather than true position -- a few
// meters of jitter is enough to flip which axis looks "further away",
// which is what makes the reported direction look random near the
// junction. Readings closer than this are ignored in favor of whatever
// direction was last known (see applyAmbulancePriority). Does not apply
// to GPS-heading readings, which come from the device's own course, not
// a position diff, so they're trusted at any distance.
const MIN_DIRECTION_DISTANCE =
  Number.parseFloat(process.env.MIN_DIRECTION_DISTANCE) || 15;

// Ignore tiny GPS changes when deriving direction from consecutive fixes.
// This prevents normal phone GPS jitter from becoming a false travel bearing.
const MIN_MOVEMENT_DISTANCE_METERS =
  Number.parseFloat(process.env.MIN_MOVEMENT_DISTANCE_METERS) || 5;

// ------------------------------------------------------------
// AMBULANCE STATE
// ------------------------------------------------------------

function defaultAmbulanceState() {
  return {
    ambulanceId: null,

    // Driver-controlled: true the instant START EMERGENCY is pressed,
    // regardless of where the ambulance is. Never distance-gated.
    emergencyRequested: false,

    latitude: null,
    longitude: null,
    accuracy: null,
    heading: null,
    speed: null,
    movementBearing: null,

    direction: null,
    directionSource: null,
    // True once signalPriority has triggered for the current request --
    // direction stops being recomputed after that (see
    // applyAmbulancePriority) so close-range GPS noise near the junction
    // can't flip it mid-crossing.
    directionLocked: false,
    distance: null,

    // Server-computed: true only while within the trigger/exit zone.
    signalPriority: false,

    lastUpdate: null,
  };
}

let ambulanceState = defaultAmbulanceState();

// ------------------------------------------------------------
// EMERGENCY OVERRIDE STATE (drives the normal-cycle signal machine)
// ------------------------------------------------------------

let ambulanceEmergencyActive = false;
let savedSignalStateBeforeAmbulance = null;

// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================
// HEADING HELPERS
// ============================================================

function normalizeHeading(heading) {
  if (typeof heading !== 'number' || !Number.isFinite(heading)) return null;
  return ((heading % 360) + 360) % 360;
}

function headingDifference(a, b) {
  const diff = Math.abs(a - b);
  return diff > 180 ? 360 - diff : diff;
}

// True compass bearing (0-359, 0=North) from point 1 to point 2. Unlike a
// raw lat/lon subtraction, this accounts for longitude degrees covering
// less real-world distance than latitude degrees away from the equator,
// and gives an actual angle instead of a crude "which axis is bigger".
function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLon = toRad(lon2 - lon1);

  const y = Math.sin(deltaLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLon);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Picks whichever configured road bearing is angularly closest to
// targetBearing. Shared by both the heading and position-fallback paths
// below so they always agree on the same set of real road directions.
function nearestRoadByBearing(targetBearing) {
  let best = null;
  let smallestDiff = Infinity;

  for (const road of SIGNAL_ROADS) {
    const diff = headingDifference(targetBearing, ROAD_BEARINGS[road]);
    if (diff < smallestDiff) {
      smallestDiff = diff;
      best = road;
    }
  }

  return { road: best, difference: smallestDiff };
}

// Heading is the direction of travel. An ambulance approaching the
// junction on a given road is travelling roughly opposite that road's
// outward bearing (ROAD_BEARINGS), i.e. inbound = outward + 180.
function directionFromHeading(heading) {
  if (heading == null) return null;

  let best = null;
  let smallestDiff = Infinity;

  for (const road of SIGNAL_ROADS) {
    const inboundBearing = (ROAD_BEARINGS[road] + 180) % 360;
    const diff = headingDifference(heading, inboundBearing);
    if (diff < smallestDiff) {
      smallestDiff = diff;
      best = road;
    }
  }

  return smallestDiff <= HEADING_TOLERANCE ? best : null;
}

// Fallback when heading is unavailable/unreliable: the true compass
// bearing from the junction to the ambulance is matched against each
// road's real outward bearing (ROAD_BEARINGS), not assumed to be exact
// cardinal directions. This is what makes non-North roads work correctly
// at a junction whose roads aren't perfectly compass-aligned.
function directionFromPosition(latitude, longitude) {
  const bearingFromSignal = bearingDegrees(
    SIGNAL_LOCATION.latitude,
    SIGNAL_LOCATION.longitude,
    latitude,
    longitude
  );

  return nearestRoadByBearing(bearingFromSignal).road;
}

function detectApproachDirection(latitude, longitude, heading, speed, movementBearing) {
  const validHeading = normalizeHeading(heading);
  const validSpeed = typeof speed === 'number' && Number.isFinite(speed) ? speed : null;
  const validMovementBearing = normalizeHeading(movementBearing);

  // GPS movement is more reliable than the phone compass for this decision.
  // The bearing is the ambulance's travel direction, so directionFromHeading
  // correctly maps it to the road the ambulance is entering from.
  if (validMovementBearing !== null) {
    const movementDirection = directionFromHeading(validMovementBearing);
    if (movementDirection) {
      return { direction: movementDirection, source: 'gps-movement' };
    }
  }

  if (validHeading !== null && validSpeed !== null && validSpeed >= MIN_HEADING_SPEED_KMH) {
    const headingDirection = directionFromHeading(validHeading);
    if (headingDirection) {
      return { direction: headingDirection, source: 'gps-heading' };
    }
  }

  return { direction: directionFromPosition(latitude, longitude), source: 'position-fallback' };
}

// ============================================================
// START / END AMBULANCE EMERGENCY (signal-cycle override)
// ============================================================

function startAmbulanceEmergency(direction) {
  if (!SIGNAL_ROADS.includes(direction)) {
    console.warn(`[AMBULANCE] Invalid direction: ${direction}`);
    return;
  }

  // An administrator may temporarily own the physical lights. Keep the
  // ambulance emergency active in memory and restore its green when the
  // administrator releases the override.
  if (adminSignalOverride) {
    ambulanceEmergencyActive = true;
    return;
  }

  if (ambulanceEmergencyActive) {
    // Already overriding -- just retarget which road is green. Never let
    // two directions be green at once: activeRoad is a single value, so
    // reassigning it here already guarantees only one GREEN / three RED.
    signalState.activeRoad = direction;
    signalState.emergency = true;
    signalState.isSimulating = true;
    signalState.simulationFinished = false;
    return;
  }

  savedSignalStateBeforeAmbulance = {
    activeRoad: signalState.activeRoad,
    emergency: signalState.emergency,
    timerRemaining: signalState.timerRemaining,
    isSimulating: signalState.isSimulating,
    simulationFinished: signalState.simulationFinished,
  };

  stopSignalTimer();

  ambulanceEmergencyActive = true;
  signalState.isSimulating = true;
  signalState.simulationFinished = false;
  signalState.emergency = true;
  signalState.activeRoad = direction;
  signalState.timerRemaining = 0;

  console.log(`[AMBULANCE] EMERGENCY GREEN -> ${direction}`);
}

function endAmbulanceEmergency() {
  if (!ambulanceEmergencyActive) return;
  ambulanceEmergencyActive = false;

  if (adminSignalOverride) {
    savedSignalStateBeforeAmbulance = null;
    return;
  }

  const saved = savedSignalStateBeforeAmbulance;
  savedSignalStateBeforeAmbulance = null;

  if (!saved) {
    signalState = defaultSignalState();
    return;
  }

  signalState.activeRoad = saved.activeRoad;
  signalState.emergency = saved.emergency;
  signalState.timerRemaining = saved.timerRemaining;
  signalState.isSimulating = saved.isSimulating;
  signalState.simulationFinished = saved.simulationFinished;

  console.log('[AMBULANCE] Emergency ended -> normal traffic restored');

  if (saved.isSimulating && signalState.vehicleCounts) {
    stopSignalTimer();
    signalTimer = setInterval(tickSignal, 1000);
  }
}

// ============================================================
// APPLY AMBULANCE PRIORITY -- single source of truth, run on every
// GPS update (and once right after START EMERGENCY is pressed).
// ============================================================

function applyAmbulancePriority() {
  if (ambulanceState.latitude === null || ambulanceState.longitude === null) {
    ambulanceState.signalPriority = false;
    return;
  }

  const distance = Math.round(
    haversineDistanceMeters(
      ambulanceState.latitude,
      ambulanceState.longitude,
      SIGNAL_LOCATION.latitude,
      SIGNAL_LOCATION.longitude
    )
  );
  ambulanceState.distance = distance;

  // Recompute direction only until it locks in (see below). Freezing it
  // is what stops the reading from flickering randomly once the ambulance
  // is close to the junction -- see MIN_DIRECTION_DISTANCE above.
  if (!ambulanceState.directionLocked) {
    const directionResult = detectApproachDirection(
      ambulanceState.latitude,
      ambulanceState.longitude,
      ambulanceState.heading,
      ambulanceState.speed,
      ambulanceState.movementBearing
    );

    const trustworthy =
      directionResult.source === 'gps-heading' || distance >= MIN_DIRECTION_DISTANCE;

    // Below MIN_DIRECTION_DISTANCE, a position-fallback reading is noise,
    // not signal -- keep whatever direction was last known instead of
    // overwriting it, unless this is the very first reading we've had.
    if (trustworthy || ambulanceState.direction === null) {
      ambulanceState.direction = directionResult.direction;
      ambulanceState.directionSource = directionResult.source;
    }
  }

  // Hysteresis between trigger and exit distance: while priority is OFF,
  // only SIGNAL_TRIGGER_DISTANCE can turn it on. Once ON, only crossing
  // back out past SIGNAL_EXIT_DISTANCE turns it off again. This is what
  // distinguishes "500m out, not yet triggered" from "just crossed the
  // junction, still within the exit zone" -- both cases can report the
  // same raw distance, so which threshold applies depends on the state
  // priority was already in, not the distance value alone.
  if (!ambulanceState.emergencyRequested) {
    ambulanceState.signalPriority = false;
    ambulanceState.directionLocked = false;
  } else if (!ambulanceState.signalPriority) {
    ambulanceState.signalPriority = distance <= SIGNAL_TRIGGER_DISTANCE;

    // Commit to this direction for the rest of the approach/crossing --
    // this is the point closest to the junction where the reading is
    // still likely to be trustworthy.
    if (ambulanceState.signalPriority) {
      ambulanceState.directionLocked = true;
    }
  } else {
    const stillInExitZone = distance <= SIGNAL_EXIT_DISTANCE;
    ambulanceState.signalPriority = stillInExitZone;

    // The ambulance has fully cleared the junction and moved past the
    // exit zone -- the emergency has been served. Auto-end the whole
    // request (not just signalPriority) so the driver doesn't have to
    // remember to press Stop, and Start Emergency is available again for
    // the next trip instead of sitting stuck showing Stop indefinitely.
    if (!stillInExitZone) {
      ambulanceState.emergencyRequested = false;
      ambulanceState.directionLocked = false;
      console.log('[AMBULANCE] Crossed exit zone -- emergency auto-ended');
    }
  }

  console.log(
    `[AMBULANCE] GPS=${ambulanceState.latitude.toFixed(6)},${ambulanceState.longitude.toFixed(6)} ` +
    `heading=${ambulanceState.heading ?? 'N/A'} deg speed=${ambulanceState.speed ?? 'N/A'} km/h ` +
    `distance=${distance}m direction=${ambulanceState.direction} source=${ambulanceState.directionSource} ` +
    `locked=${ambulanceState.directionLocked} requested=${ambulanceState.emergencyRequested} priority=${ambulanceState.signalPriority}`
  );

  if (ambulanceState.signalPriority && ambulanceState.direction) {
    startAmbulanceEmergency(ambulanceState.direction);
  } else if (ambulanceEmergencyActive) {
    endAmbulanceEmergency();
  }
}

// ============================================================
// GPS WATCHDOG -- drop a stale emergency request/priority if the phone
// stops sending updates (lost connection, app killed, etc).
// ============================================================

setInterval(() => {
  if (
    ambulanceState.emergencyRequested &&
    ambulanceState.lastUpdate &&
    Date.now() - ambulanceState.lastUpdate > GPS_TIMEOUT_MS
  ) {
    console.warn('[AMBULANCE] GPS TIMEOUT - emergency request cleared');
    ambulanceState.emergencyRequested = false;
    ambulanceState.signalPriority = false;
    ambulanceState.directionLocked = false;
    if (ambulanceEmergencyActive) endAmbulanceEmergency();
  }
}, 2000);

// ============================================================
// START EMERGENCY
// ============================================================
//
// Unconditional: the driver can press this from anywhere, with or
// without a GPS fix yet. It only flips emergencyRequested on and kicks
// off tracking -- it does NOT grant signal priority by itself. Priority
// turns on separately, later, once a location update puts the ambulance
// within SIGNAL_TRIGGER_DISTANCE (see applyAmbulancePriority).
// ============================================================

app.post('/api/ambulance/start', (req, res) => {
  const { ambulanceId } = req.body;

  if (!ambulanceId) {
    return res.status(400).json({ success: false, message: 'ambulanceId is required' });
  }

  const isNewEmergency = !ambulanceState.emergencyRequested;
  ambulanceState.ambulanceId = ambulanceId;
  if (isNewEmergency) {
    // Do not reuse the previous trip's road guess or travel vector.
    // The next GPS fixes will establish the new approach direction.
    ambulanceState.direction = null;
    ambulanceState.directionSource = null;
    ambulanceState.directionLocked = false;
    ambulanceState.movementBearing = null;
  }
  ambulanceState.emergencyRequested = true;
  ambulanceState.lastUpdate = Date.now();

  // Re-evaluate immediately in case a GPS fix already arrived earlier
  // (e.g. the driver pressed Stop then Start again without moving).
  applyAmbulancePriority();

  console.log(`[AMBULANCE] EMERGENCY REQUESTED by ${ambulanceId}`);

  return res.json({
    success: true,
    emergencyRequested: ambulanceState.emergencyRequested,
    signalPriority: ambulanceState.signalPriority,
    ambulanceId: ambulanceState.ambulanceId,
    latitude: ambulanceState.latitude,
    longitude: ambulanceState.longitude,
    accuracy: ambulanceState.accuracy,
    heading: ambulanceState.heading,
    speed: ambulanceState.speed,
    direction: ambulanceState.direction,
    directionSource: ambulanceState.directionSource,
    directionLocked: ambulanceState.directionLocked,
    distance: ambulanceState.distance,
    signalName: SIGNAL_LOCATION.name,
    signalLatitude: SIGNAL_LOCATION.latitude,
    signalLongitude: SIGNAL_LOCATION.longitude,
    triggerDistance: SIGNAL_TRIGGER_DISTANCE,
    exitDistance: SIGNAL_EXIT_DISTANCE,
  });
});

// ============================================================
// LOCATION UPDATE -- phone should call this every 1-3 seconds while
// emergencyRequested is true (and may keep calling it afterwards too;
// it's harmless when there's no active request).
// ============================================================

app.post('/api/ambulance/location', (req, res) => {
  const { ambulanceId, latitude, longitude, accuracy, heading, speed } = req.body;

  if (!ambulanceId || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({
      success: false,
      message: 'ambulanceId, latitude and longitude are required',
    });
  }

  const previousLatitude = ambulanceState.latitude;
  const previousLongitude = ambulanceState.longitude;

  if (previousLatitude !== null && previousLongitude !== null) {
    const movementDistance = haversineDistanceMeters(
      previousLatitude,
      previousLongitude,
      latitude,
      longitude
    );
    if (movementDistance >= MIN_MOVEMENT_DISTANCE_METERS) {
      ambulanceState.movementBearing = bearingDegrees(
        previousLatitude,
        previousLongitude,
        latitude,
        longitude
      );
    }
  }

  ambulanceState.ambulanceId = ambulanceId;
  ambulanceState.latitude = latitude;
  ambulanceState.longitude = longitude;
  ambulanceState.accuracy = typeof accuracy === 'number' ? accuracy : null;
  ambulanceState.heading = normalizeHeading(heading);
  ambulanceState.speed = typeof speed === 'number' && Number.isFinite(speed) ? speed : null;
  ambulanceState.lastUpdate = Date.now();

  applyAmbulancePriority();

  console.log(
    `[AMBULANCE LOCATION] ${ambulanceId} | lat=${latitude.toFixed(6)} lon=${longitude.toFixed(6)} | ` +
    `heading=${ambulanceState.heading ?? 'N/A'} speed=${ambulanceState.speed ?? 'N/A'} | ` +
    `direction=${ambulanceState.direction} distance=${ambulanceState.distance}m | ` +
    `requested=${ambulanceState.emergencyRequested} priority=${ambulanceState.signalPriority}`
  );

  return res.json({
    success: true,
    ambulanceId: ambulanceState.ambulanceId,
    latitude: ambulanceState.latitude,
    longitude: ambulanceState.longitude,
    accuracy: ambulanceState.accuracy,
    heading: ambulanceState.heading,
    speed: ambulanceState.speed,
    emergencyRequested: ambulanceState.emergencyRequested,
    direction: ambulanceState.direction,
    directionSource: ambulanceState.directionSource,
    directionLocked: ambulanceState.directionLocked,
    distance: ambulanceState.distance,
    signalPriority: ambulanceState.signalPriority,
    signalName: SIGNAL_LOCATION.name,
    signalLatitude: SIGNAL_LOCATION.latitude,
    signalLongitude: SIGNAL_LOCATION.longitude,
    triggerDistance: SIGNAL_TRIGGER_DISTANCE,
    exitDistance: SIGNAL_EXIT_DISTANCE,
  });
});

// ============================================================
// STOP EMERGENCY
// ============================================================

app.post('/api/ambulance/stop', (req, res) => {
  ambulanceState.emergencyRequested = false;
  ambulanceState.signalPriority = false;
  ambulanceState.directionLocked = false;

  if (ambulanceEmergencyActive) endAmbulanceEmergency();

  console.log('[AMBULANCE] Emergency manually stopped');

  return res.json({ success: true, emergencyRequested: false, signalPriority: false });
});

// ============================================================
// AMBULANCE STATUS
// ============================================================

app.get('/api/ambulance/status', (req, res) => {
  return res.json({
    success: true,
    ambulanceId: ambulanceState.ambulanceId,
    emergencyRequested: ambulanceState.emergencyRequested,
    latitude: ambulanceState.latitude,
    longitude: ambulanceState.longitude,
    accuracy: ambulanceState.accuracy,
    heading: ambulanceState.heading,
    speed: ambulanceState.speed,
    direction: ambulanceState.direction,
    directionSource: ambulanceState.directionSource,
    directionLocked: ambulanceState.directionLocked,
    distance: ambulanceState.distance,
    signalPriority: ambulanceState.signalPriority,
    signalName: SIGNAL_LOCATION.name,
    signalLatitude: SIGNAL_LOCATION.latitude,
    signalLongitude: SIGNAL_LOCATION.longitude,
    triggerDistance: SIGNAL_TRIGGER_DISTANCE,
    exitDistance: SIGNAL_EXIT_DISTANCE,
  });
});

// ============================================================
// TEST EMERGENCY -- lets you exercise the ESP32/signal chain without a
// phone. POST /api/emergency/test { "direction": "North" }
// ============================================================

app.post('/api/emergency/test', (req, res) => {
  const { direction } = req.body;

  if (!SIGNAL_ROADS.includes(direction)) {
    return res.status(400).json({
      success: false,
      message: `direction must be one of: ${SIGNAL_ROADS.join(', ')}`,
    });
  }

  ambulanceState.ambulanceId = ambulanceState.ambulanceId || 'TEST-AMB';
  ambulanceState.emergencyRequested = true;
  ambulanceState.signalPriority = true;
  ambulanceState.direction = direction;
  ambulanceState.directionSource = 'test';
  ambulanceState.directionLocked = true;
  ambulanceState.distance = 0;
  ambulanceState.lastUpdate = Date.now();

  startAmbulanceEmergency(direction);

  console.log(`[TEST] Emergency -> ${direction}`);

  return res.json({ success: true, emergencyRequested: true, direction, distance: 0, signalPriority: true });
});

// ============================================================
// CLEAR TEST EMERGENCY
// ============================================================

app.post('/api/emergency/clear', (req, res) => {
  ambulanceState = defaultAmbulanceState();

  if (ambulanceEmergencyActive) endAmbulanceEmergency();

  console.log('[TEST] Emergency cleared');

  return res.json({ success: true, emergencyRequested: false });
});

// ============================================================
// ADMIN SIGNAL OVERRIDE
// ============================================================

app.post('/api/admin/signal/override', (req, res) => {
  const { direction } = req.body;

  if (!SIGNAL_ROADS.includes(direction)) {
    return res.status(400).json({
      success: false,
      message: `direction must be one of: ${SIGNAL_ROADS.join(', ')}`,
    });
  }

  if (!adminSignalOverride) {
    savedSignalStateBeforeAdmin = { ...signalState };
    stopSignalTimer();
    adminSignalOverride = true;
  }

  signalState.isSimulating = true;
  signalState.simulationFinished = false;
  signalState.activeRoad = direction;
  signalState.timerRemaining = 0;
  signalState.emergency = false;

  console.log(`[ADMIN] Manual GREEN -> ${direction}`);

  return res.json({
    success: true,
    direction,
    adminSignalOverride: true,
    ambulancePriority: ambulanceEmergencyActive,
    state: signalState,
  });
});

app.post('/api/admin/signal/clear', (req, res) => {
  if (!adminSignalOverride) {
    return res.json({
      success: true,
      adminSignalOverride: false,
      ambulancePriority: ambulanceEmergencyActive,
      state: signalState,
    });
  }

  adminSignalOverride = false;
  const saved = savedSignalStateBeforeAdmin;
  savedSignalStateBeforeAdmin = null;

  if (ambulanceEmergencyActive && ambulanceState.direction) {
    signalState.isSimulating = true;
    signalState.simulationFinished = false;
    signalState.activeRoad = ambulanceState.direction;
    signalState.timerRemaining = 0;
    signalState.emergency = true;
    console.log(`[ADMIN] Override cleared -> ambulance GREEN ${ambulanceState.direction}`);
  } else {
    if (saved) signalState = { ...saved };
    if (signalState.isSimulating && signalState.vehicleCounts) {
      stopSignalTimer();
      signalTimer = setInterval(tickSignal, 1000);
    }
    console.log('[ADMIN] Override cleared -> normal traffic restored');
  }

  return res.json({
    success: true,
    adminSignalOverride: false,
    ambulancePriority: ambulanceEmergencyActive,
    state: signalState,
  });
});

app.post('/api/admin/signal/all-red', (req, res) => {
  if (!adminSignalOverride) {
    savedSignalStateBeforeAdmin = { ...signalState };
    stopSignalTimer();
    adminSignalOverride = true;
  }

  // No active road is the shared all-red representation used by the ESP32
  // and dashboard clients, regardless of normal or ambulance activity.
  signalState.isSimulating = false;
  signalState.activeRoad = null;
  signalState.timerRemaining = 0;
  signalState.emergency = false;
  signalState.simulationFinished = false;

  console.log('[ADMIN] ALL RED override enabled');

  return res.json({
    success: true,
    adminSignalOverride: true,
    allRed: true,
    ambulancePriority: ambulanceEmergencyActive,
    state: signalState,
  });
});

// ============================================================
// HTTP SERVER
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log();
    console.log(
      '=============================================='
    );

    console.log(
      ' SMART TRAFFIC EXPRESS SERVER'
    );

    console.log(
      '=============================================='
    );

    console.log(
      `HTTP Port: ${PORT}`
    );

    console.log(
      `Flask AI: ${FLASK_API_URL}`
    );

    console.log(
      `Traffic Mode: ${TRAFFIC_MODE}${IS_TEST_MODE ? ' (using DUMMY_JUNCTION_LAT/LON + ROAD_BEARING_1-4)' : ''}`
    );

    console.log(
      `Signal Latitude: ${SIGNAL_LOCATION.latitude}`
    );

    console.log(
      `Signal Longitude: ${SIGNAL_LOCATION.longitude}`
    );

    console.log(
      `Road Bearings: N=${ROAD_BEARINGS.North} E=${ROAD_BEARINGS.East} S=${ROAD_BEARINGS.South} W=${ROAD_BEARINGS.West}`
    );

    console.log(
      `Trigger distance: ${SIGNAL_TRIGGER_DISTANCE} meters`
    );

    console.log(
      `Exit distance: ${SIGNAL_EXIT_DISTANCE} meters`
    );

    console.log(
      `GPS Timeout: ${GPS_TIMEOUT_MS} ms`
    );

    console.log(
      `Heading tolerance: ${HEADING_TOLERANCE}°`
    );

    console.log(
      `Minimum heading speed: ${MIN_HEADING_SPEED_KMH} km/h`
    );

    console.log(
      '=============================================='
    );

    console.log(
      `Express server running on port ${PORT}`
    );

    console.log(
      `Static uploads served from: ${uploadsDir}`
    );

    console.log(
      '=============================================='
    );

  }
);


// ============================================================
// HTTPS SERVER FOR AMBULANCE PHONE
// ============================================================
//
// Browser geolocation requires a secure context.
// This HTTPS listener allows your ambulance page to use GPS.
// ============================================================

const HTTPS_PORT =
  process.env.HTTPS_PORT || 5443;


const certDir =
  path.join(
    __dirname,
    '.https-cert'
  );


const keyPath =
  path.join(
    certDir,
    'key.pem'
  );


const certPath =
  path.join(
    certDir,
    'cert.pem'
  );


async function loadOrCreateCert() {

  if (
    fs.existsSync(keyPath) &&
    fs.existsSync(certPath)
  ) {

    return {

      key:
        fs.readFileSync(
          keyPath
        ),

      cert:
        fs.readFileSync(
          certPath
        )

    };

  }


  const pems =
    await selfsigned.generate(

      [
        {
          name:
            'commonName',

          value:
            'smart-traffic-prototype'
        }
      ],

      {

        days: 3650,

        keySize: 2048,

        algorithm: 'sha256'

      }

    );


  fs.mkdirSync(
    certDir,
    {
      recursive: true
    }
  );


  fs.writeFileSync(
    keyPath,
    pems.private
  );


  fs.writeFileSync(
    certPath,
    pems.cert
  );


  return {

    key:
      pems.private,

    cert:
      pems.cert

  };

}


loadOrCreateCert()

  .then(
    ({ key, cert }) => {

      https

        .createServer(
          {
            key,
            cert
          },
          app
        )

        .listen(
          HTTPS_PORT,
          '0.0.0.0',
          () => {

            console.log(
              `Express HTTPS listener running on port ${HTTPS_PORT}`
            );

            console.log(
              `Ambulance HTTPS URL: https://YOUR-PC-IP:${HTTPS_PORT}`
            );

          }

        );

    }

  )

  .catch(
    err => {

      console.error(

        'Failed to start HTTPS listener ' +
        '(ambulance page will not have GPS access):',

        err.message

      );

    }
  );