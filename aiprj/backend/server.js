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

      state: signalState

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

// ------------------------------------------------------------
// CONFIGURATION
// ------------------------------------------------------------

const SIGNAL_LOCATION = {
  signalId: 'SIG-001',
  name: process.env.SIGNAL_NAME || 'Prototype Junction',

  latitude:
    Number.parseFloat(process.env.SIGNAL_LATITUDE) ||
    11.275600,

  longitude:
    Number.parseFloat(process.env.SIGNAL_LONGITUDE) ||
    77.583200,

  // 50 meter geofence
  geofenceRadius:
    Number.parseFloat(process.env.GEOFENCE_RADIUS) ||
    50,
};

// GPS must arrive within 15 seconds
const GPS_TIMEOUT_MS =
  Number.parseInt(process.env.GPS_TIMEOUT_MS, 10) ||
  15000;

// The geofence is tight (see GEOFENCE_RADIUS above), so a moving ambulance
// drives straight out of it again within seconds of triggering priority.
// Once emergency starts, keep the green held for this long after exiting
// the geofence so the ambulance actually has time to clear the junction,
// instead of the signal snapping back to normal the instant it crosses out.
const EMERGENCY_GRACE_MS =
  Number.parseInt(process.env.EMERGENCY_GRACE_MS, 10) ||
  10000;

// Heading tolerance
const HEADING_TOLERANCE =
  Number.parseFloat(process.env.HEADING_TOLERANCE) ||
  45;

// Heading is trusted only above 5 km/h
const MIN_HEADING_SPEED_KMH =
  Number.parseFloat(process.env.MIN_HEADING_SPEED_KMH) ||
  5;


// ------------------------------------------------------------
// AMBULANCE STATE
// ------------------------------------------------------------

function defaultAmbulanceState() {
  return {
    ambulanceId: null,

    emergency: false,

    latitude: null,
    longitude: null,
    accuracy: null,

    heading: null,
    speed: null,

    direction: null,
    directionSource: null,

    distance: null,

    insideGeofence: false,

    // Timestamp of when the ambulance first left the geofence while an
    // emergency was active; null while inside (or when no emergency is
    // running). Drives the EMERGENCY_GRACE_MS hold-over below.
    geofenceExitAt: null,

    signalPriority: false,

    lastUpdate: null,
  };
}

let ambulanceState = defaultAmbulanceState();


// ------------------------------------------------------------
// EMERGENCY OVERRIDE STATE
// ------------------------------------------------------------

let ambulanceEmergencyActive = false;

let savedSignalStateBeforeAmbulance = null;


// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function haversineDistanceMeters(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371000;

  const toRad = (value) =>
    (value * Math.PI) / 180;

  const dLat =
    toRad(lat2 - lat1);

  const dLon =
    toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}


// ============================================================
// NORMALIZE HEADING
// ============================================================

function normalizeHeading(heading) {

  if (
    typeof heading !== 'number' ||
    !Number.isFinite(heading)
  ) {
    return null;
  }

  if (heading < 0) {
    heading = heading % 360 + 360;
  }

  return heading % 360;
}


// ============================================================
// ANGULAR DIFFERENCE
// ============================================================

function headingDifference(a, b) {

  let diff =
    Math.abs(a - b);

  if (diff > 180) {
    diff = 360 - diff;
  }

  return diff;
}


// ============================================================
// HEADING → ROAD
// ============================================================
//
// 0°   = North
// 90°  = East
// 180° = South
// 270° = West
//
// Example:
// heading 10°  → North
// heading 85°  → East
// heading 175° → South
// heading 265° → West
//
// ±45° tolerance is used.
// ============================================================

function directionFromHeading(heading) {

  if (heading == null) {
    return null;
  }

  const directions = [
    {
      name: 'North',
      bearing: 0,
    },
    {
      name: 'East',
      bearing: 90,
    },
    {
      name: 'South',
      bearing: 180,
    },
    {
      name: 'West',
      bearing: 270,
    },
  ];

  let bestDirection = null;
  let smallestDifference = Infinity;

  for (const item of directions) {

    const difference =
      headingDifference(
        heading,
        item.bearing
      );

    if (
      difference <
      smallestDifference
    ) {
      smallestDifference =
        difference;

      bestDirection =
        item.name;
    }
  }

  if (
    smallestDifference <=
    HEADING_TOLERANCE
  ) {
    return bestDirection;
  }

  return null;
}


// ============================================================
// POSITION FALLBACK
// ============================================================
//
// Used only when heading is unavailable/unreliable.
//
// This is NOT the primary direction method.
// ============================================================

function directionFromPosition(
  latitude,
  longitude
) {

  const dLat =
    latitude -
    SIGNAL_LOCATION.latitude;

  const dLon =
    longitude -
    SIGNAL_LOCATION.longitude;

  if (
    Math.abs(dLat) >=
    Math.abs(dLon)
  ) {

    if (dLat >= 0) {
      return 'North';
    }

    return 'South';
  }

  if (dLon >= 0) {
    return 'East';
  }

  return 'West';
}


// ============================================================
// DETECT APPROACH DIRECTION
// ============================================================

function detectApproachDirection(
  latitude,
  longitude,
  heading,
  speed
) {

  // ----------------------------------------------------------
  // PRIMARY METHOD: GPS HEADING
  // ----------------------------------------------------------

  const validHeading =
    normalizeHeading(heading);

  const validSpeed =
    typeof speed === 'number' &&
    Number.isFinite(speed)
      ? speed
      : null;

  if (
    validHeading !== null &&
    validSpeed !== null &&
    validSpeed >=
      MIN_HEADING_SPEED_KMH
  ) {

    const headingDirection =
      directionFromHeading(
        validHeading
      );

    if (headingDirection) {

      return {
        direction:
          headingDirection,

        source:
          'gps-heading',
      };
    }
  }


  // ----------------------------------------------------------
  // FALLBACK
  // ----------------------------------------------------------

  return {
    direction:
      directionFromPosition(
        latitude,
        longitude
      ),

    source:
      'position-fallback',
  };
}


// ============================================================
// START AMBULANCE EMERGENCY
// ============================================================

function startAmbulanceEmergency(
  direction
) {

  if (
    !SIGNAL_ROADS.includes(
      direction
    )
  ) {

    console.warn(
      `[AMBULANCE] Invalid direction: ${direction}`
    );

    return;
  }


  // Already active
  if (
    ambulanceEmergencyActive
  ) {

    // Update direction dynamically
    signalState.activeRoad =
      direction;

    signalState.emergency =
      true;

    signalState.isSimulating =
      true;

    signalState.simulationFinished =
      false;

    return;
  }


  // ----------------------------------------------------------
  // SAVE NORMAL TRAFFIC STATE
  // ----------------------------------------------------------

  savedSignalStateBeforeAmbulance = {
    activeRoad:
      signalState.activeRoad,

    emergency:
      signalState.emergency,

    timerRemaining:
      signalState.timerRemaining,

    isSimulating:
      signalState.isSimulating,

    simulationFinished:
      signalState.simulationFinished,
  };


  // ----------------------------------------------------------
  // STOP NORMAL TIMER
  // ----------------------------------------------------------

  stopSignalTimer();


  // ----------------------------------------------------------
  // ACTIVATE EMERGENCY
  // ----------------------------------------------------------

  ambulanceEmergencyActive =
    true;

  signalState.isSimulating =
    true;

  signalState.simulationFinished =
    false;

  signalState.emergency =
    true;

  signalState.activeRoad =
    direction;

  signalState.timerRemaining =
    0;


  console.log(
    `[AMBULANCE] 🚑 EMERGENCY GREEN → ${direction}`
  );
}


// ============================================================
// END AMBULANCE EMERGENCY
// ============================================================

function endAmbulanceEmergency() {

  if (
    !ambulanceEmergencyActive
  ) {
    return;
  }

  ambulanceEmergencyActive =
    false;


  const saved =
    savedSignalStateBeforeAmbulance;

  savedSignalStateBeforeAmbulance =
    null;


  if (!saved) {

    signalState =
      defaultSignalState();

    return;
  }


  // ----------------------------------------------------------
  // RESTORE NORMAL TRAFFIC
  // ----------------------------------------------------------

  signalState.activeRoad =
    saved.activeRoad;

  signalState.emergency =
    saved.emergency;

  signalState.timerRemaining =
    saved.timerRemaining;

  signalState.isSimulating =
    saved.isSimulating;

  signalState.simulationFinished =
    saved.simulationFinished;


  console.log(
    '[AMBULANCE] Emergency ended → normal traffic restored'
  );


  // ----------------------------------------------------------
  // RESTART NORMAL TIMER
  // ----------------------------------------------------------

  if (
    saved.isSimulating &&
    signalState.vehicleCounts
  ) {

    stopSignalTimer();

    signalTimer =
      setInterval(
        tickSignal,
        1000
      );
  }
}


// ============================================================
// APPLY AMBULANCE PRIORITY
// ============================================================
//
// This is the SINGLE source of truth.
//
// Every GPS update comes here.
// ============================================================

function applyAmbulancePriority() {

  // ----------------------------------------------------------
  // NO GPS
  // ----------------------------------------------------------

  if (
    ambulanceState.latitude === null ||
    ambulanceState.longitude === null
  ) {

    ambulanceState.insideGeofence =
      false;

    ambulanceState.signalPriority =
      false;

    return;
  }


  // ----------------------------------------------------------
  // DISTANCE
  // ----------------------------------------------------------

  const distance =
    Math.round(
      haversineDistanceMeters(
        ambulanceState.latitude,
        ambulanceState.longitude,

        SIGNAL_LOCATION.latitude,
        SIGNAL_LOCATION.longitude
      )
    );


  ambulanceState.distance =
    distance;


  // ----------------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------------

  const directionResult =
    detectApproachDirection(
      ambulanceState.latitude,
      ambulanceState.longitude,
      ambulanceState.heading,
      ambulanceState.speed
    );


  ambulanceState.direction =
    directionResult.direction;

  ambulanceState.directionSource =
    directionResult.source;


  // ----------------------------------------------------------
  // GEOFENCE
  // ----------------------------------------------------------

  ambulanceState.insideGeofence =
    distance <=
    SIGNAL_LOCATION.geofenceRadius;


  console.log(
    `[AMBULANCE] ` +
    `GPS=${ambulanceState.latitude.toFixed(6)},${ambulanceState.longitude.toFixed(6)} ` +
    `heading=${ambulanceState.heading ?? 'N/A'}° ` +
    `speed=${ambulanceState.speed ?? 'N/A'}km/h ` +
    `distance=${distance}m ` +
    `direction=${ambulanceState.direction} ` +
    `source=${ambulanceState.directionSource} ` +
    `inside=${ambulanceState.insideGeofence}`
  );


  // ----------------------------------------------------------
  // LEAVE GEOFENCE -- grace period before revoking
  // ----------------------------------------------------------
  //
  // The geofence is tight, so exiting it doesn't clear the emergency
  // immediately. Instead it starts (or continues) an EMERGENCY_GRACE_MS
  // countdown, giving the ambulance time to actually cross the junction.
  // Coming back inside cancels the countdown.
  // ----------------------------------------------------------

  if (ambulanceState.insideGeofence) {

    ambulanceState.geofenceExitAt =
      null;

  } else if (ambulanceState.emergency) {

    if (!ambulanceState.geofenceExitAt) {

      ambulanceState.geofenceExitAt =
        Date.now();

      console.log(
        `[AMBULANCE] 🚑 LEFT ${SIGNAL_LOCATION.geofenceRadius}m GEOFENCE -- ${EMERGENCY_GRACE_MS / 1000}s grace period started`
      );

    } else if (
      Date.now() - ambulanceState.geofenceExitAt >=
      EMERGENCY_GRACE_MS
    ) {

      console.log(
        '[AMBULANCE] 🚑 GRACE PERIOD EXPIRED -- emergency cleared'
      );

      ambulanceState.emergency =
        false;

      ambulanceState.geofenceExitAt =
        null;
    }
  }


  // ----------------------------------------------------------
  // SIGNAL PRIORITY
  // ----------------------------------------------------------
  //
  // Priority stays on through the grace period (i.e. as long as
  // `emergency` is still true), not just while strictly inside the
  // geofence -- that's what keeps the green held while crossing.
  // ----------------------------------------------------------

  ambulanceState.signalPriority =
    ambulanceState.emergency;


  // ----------------------------------------------------------
  // APPLY / REMOVE EMERGENCY
  // ----------------------------------------------------------

  if (
    ambulanceState.signalPriority &&
    ambulanceState.direction
  ) {

    startAmbulanceEmergency(
      ambulanceState.direction
    );

  }

  else if (
    ambulanceEmergencyActive
  ) {

    endAmbulanceEmergency();
  }
}


// ============================================================
// GPS WATCHDOG
// ============================================================
//
// If the ambulance phone stops sending GPS for 15 seconds,
// emergency priority is automatically removed.
// ============================================================

setInterval(() => {

  if (
    ambulanceState.emergency &&
    ambulanceState.lastUpdate &&
    Date.now() -
      ambulanceState.lastUpdate >
      GPS_TIMEOUT_MS
  ) {

    console.warn(
      '[AMBULANCE] ⚠️ GPS TIMEOUT - emergency cleared'
    );


    ambulanceState.emergency =
      false;

    ambulanceState.signalPriority =
      false;


    if (
      ambulanceEmergencyActive
    ) {

      endAmbulanceEmergency();
    }
  }

}, 2000);


// ============================================================
// START EMERGENCY
// ============================================================

app.post(
  '/api/ambulance/start',
  (req, res) => {

    const {
      ambulanceId
    } = req.body;


    if (!ambulanceId) {

      return res.status(400).json({
        success: false,
        message:
          'ambulanceId is required',
      });
    }


    ambulanceState.ambulanceId =
      ambulanceId;


    // --------------------------------------------------------
    // GPS REQUIRED
    // --------------------------------------------------------

    if (
      ambulanceState.latitude === null ||
      ambulanceState.longitude === null
    ) {

      return res.json({

        success: false,

        emergency: false,

        insideGeofence: false,

        message:
          'Waiting for GPS location',

      });
    }


    // --------------------------------------------------------
    // CHECK GEOFENCE BEFORE GRANTING EMERGENCY
    // --------------------------------------------------------

    applyAmbulancePriority();


    if (
      !ambulanceState.insideGeofence
    ) {

      return res.json({

        success: false,

        emergency: false,

        insideGeofence: false,

        direction:
          ambulanceState.direction,

        directionSource:
          ambulanceState.directionSource,

        distance:
          ambulanceState.distance,

        message:
          `Ambulance must be within ${SIGNAL_LOCATION.geofenceRadius} meters of the junction`,

      });
    }


    // --------------------------------------------------------
    // GRANT EMERGENCY
    // --------------------------------------------------------

    ambulanceState.emergency =
      true;

    ambulanceState.lastUpdate =
      Date.now();


    applyAmbulancePriority();


    console.log(
      `[AMBULANCE] 🚨 EMERGENCY STARTED ` +
      `→ ${ambulanceState.direction}`
    );


    return res.json({

      success: true,

      emergency:
        ambulanceState.emergency,

      insideGeofence:
        ambulanceState.insideGeofence,

      signalPriority:
        ambulanceState.signalPriority,

      ambulanceId:
        ambulanceState.ambulanceId,

      latitude:
        ambulanceState.latitude,

      longitude:
        ambulanceState.longitude,

      accuracy:
        ambulanceState.accuracy,

      heading:
        ambulanceState.heading,

      speed:
        ambulanceState.speed,

      direction:
        ambulanceState.direction,

      directionSource:
        ambulanceState.directionSource,

      distance:
        ambulanceState.distance,

      signalName:
        SIGNAL_LOCATION.name,

    });
  }
);


// ============================================================
// LOCATION UPDATE
// ============================================================
//
// Phone should call this every 1-3 seconds.
// ============================================================

app.post(
  '/api/ambulance/location',
  (req, res) => {

    const {
      ambulanceId,
      latitude,
      longitude,
      accuracy,
      heading,
      speed,
      emergency,
    } = req.body;


    // --------------------------------------------------------
    // VALIDATION
    // --------------------------------------------------------

    if (
      !ambulanceId ||
      typeof latitude !== 'number' ||
      typeof longitude !== 'number'
    ) {

      return res.status(400).json({

        success: false,

        message:
          'ambulanceId, latitude and longitude are required',

      });
    }


    // --------------------------------------------------------
    // STORE GPS
    // --------------------------------------------------------

    ambulanceState.ambulanceId =
      ambulanceId;

    ambulanceState.latitude =
      latitude;

    ambulanceState.longitude =
      longitude;

    ambulanceState.accuracy =
      typeof accuracy === 'number'
        ? accuracy
        : null;

    ambulanceState.heading =
      normalizeHeading(
        heading
      );

    ambulanceState.speed =
      typeof speed === 'number'
        ? speed
        : null;

    ambulanceState.lastUpdate =
      Date.now();


    // --------------------------------------------------------
    // EXPLICIT STOP
    // --------------------------------------------------------

    if (
      emergency === false
    ) {

      ambulanceState.emergency =
        false;
    }


    // --------------------------------------------------------
    // RECALCULATE EVERYTHING
    // --------------------------------------------------------

    applyAmbulancePriority();


    // --------------------------------------------------------
    // LOG
    // --------------------------------------------------------

    console.log(
      `[AMBULANCE LOCATION] ` +
      `${ambulanceId} | ` +
      `lat=${latitude.toFixed(6)} | ` +
      `lon=${longitude.toFixed(6)} | ` +
      `heading=${ambulanceState.heading ?? 'N/A'} | ` +
      `speed=${ambulanceState.speed ?? 'N/A'} | ` +
      `direction=${ambulanceState.direction} | ` +
      `distance=${ambulanceState.distance}m | ` +
      `inside=${ambulanceState.insideGeofence} | ` +
      `emergency=${ambulanceState.emergency}`
    );


    return res.json({

      success: true,

      ambulanceId:
        ambulanceState.ambulanceId,

      latitude:
        ambulanceState.latitude,

      longitude:
        ambulanceState.longitude,

      accuracy:
        ambulanceState.accuracy,

      heading:
        ambulanceState.heading,

      speed:
        ambulanceState.speed,

      emergency:
        ambulanceState.emergency,

      insideGeofence:
        ambulanceState.insideGeofence,

      direction:
        ambulanceState.direction,

      directionSource:
        ambulanceState.directionSource,

      distance:
        ambulanceState.distance,

      signalPriority:
        ambulanceState.signalPriority,

      signalName:
        SIGNAL_LOCATION.name,

    });
  }
);


// ============================================================
// STOP EMERGENCY
// ============================================================

app.post(
  '/api/ambulance/stop',
  (req, res) => {

    ambulanceState.emergency =
      false;

    ambulanceState.signalPriority =
      false;


    if (
      ambulanceEmergencyActive
    ) {

      endAmbulanceEmergency();
    }


    console.log(
      '[AMBULANCE] Emergency manually stopped'
    );


    return res.json({

      success: true,

      emergency: false,

      signalPriority: false,

    });
  }
);


// ============================================================
// AMBULANCE STATUS
// ============================================================

app.get(
  '/api/ambulance/status',
  (req, res) => {

    return res.json({

      success: true,

      ambulanceId:
        ambulanceState.ambulanceId,

      emergency:
        ambulanceState.emergency,

      latitude:
        ambulanceState.latitude,

      longitude:
        ambulanceState.longitude,

      accuracy:
        ambulanceState.accuracy,

      heading:
        ambulanceState.heading,

      speed:
        ambulanceState.speed,

      insideGeofence:
        ambulanceState.insideGeofence,

      direction:
        ambulanceState.direction,

      directionSource:
        ambulanceState.directionSource,

      distance:
        ambulanceState.distance,

      signalPriority:
        ambulanceState.signalPriority,

      signalName:
        SIGNAL_LOCATION.name,

      geofenceRadius:
        SIGNAL_LOCATION.geofenceRadius,

    });
  }
);


// ============================================================
// TEST EMERGENCY
// ============================================================
//
// This lets you test ESP32 without moving the phone.
//
// POST:
// /api/emergency/test
//
// Body:
// {
//   "direction": "North"
// }
//
// ============================================================

app.post(
  '/api/emergency/test',
  (req, res) => {

    const {
      direction
    } = req.body;


    if (
      !SIGNAL_ROADS.includes(
        direction
      )
    ) {

      return res.status(400).json({

        success: false,

        message:
          `direction must be one of: ${SIGNAL_ROADS.join(', ')}`,

      });
    }


    ambulanceState.ambulanceId =
      ambulanceState.ambulanceId ||
      'TEST-AMB';


    ambulanceState.emergency =
      true;

    ambulanceState.signalPriority =
      true;

    ambulanceState.direction =
      direction;

    ambulanceState.directionSource =
      'test';

    ambulanceState.distance =
      0;

    ambulanceState.insideGeofence =
      true;

    ambulanceState.lastUpdate =
      Date.now();


    startAmbulanceEmergency(
      direction
    );


    console.log(
      `[TEST] 🚑 Emergency → ${direction}`
    );


    return res.json({

      success: true,

      emergency: true,

      direction,

      distance: 0,

      insideGeofence: true,

      signalPriority: true,

    });
  }
);


// ============================================================
// CLEAR TEST EMERGENCY
// ============================================================

app.post(
  '/api/emergency/clear',
  (req, res) => {

    ambulanceState =
      defaultAmbulanceState();


    if (
      ambulanceEmergencyActive
    ) {

      endAmbulanceEmergency();
    }


    console.log(
      '[TEST] Emergency cleared'
    );


    return res.json({

      success: true,

      emergency: false,

    });
  }
);
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
      `Signal Latitude: ${SIGNAL_LOCATION.latitude}`
    );

    console.log(
      `Signal Longitude: ${SIGNAL_LOCATION.longitude}`
    );

    console.log(
      `Geofence: ${SIGNAL_LOCATION.geofenceRadius} meters`
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