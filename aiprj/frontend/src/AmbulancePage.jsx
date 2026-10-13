import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from './config';
import {
  startEmergency,
  sendLocation,
  stopEmergency,
} from './services/ambulanceApi';

// Fixed for this prototype -- multi-ambulance management is a future
// enhancement, not needed for the demo.
const AMBULANCE_ID = 'AMB-001';

// How often the phone's GPS position is POSTed to the backend. watchPosition
// itself may fire much more often; we only forward at this cadence. Kept
// short so the trigger/exit-distance crossing near the junction is caught
// promptly rather than up to a full interval late.
const GPS_UPDATE_INTERVAL = 2000;

// Matches GPS_TIMEOUT_MS on the backend -- purely for the UI warning banner,
// the backend enforces the actual failsafe independently.
const GPS_TIMEOUT_MS = 15000;

function StatusRow({ label, children }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-white/10 last:border-b-0">
      <span className="text-xs uppercase tracking-wider text-slate-400">{label}</span>
      <span className="text-sm font-semibold text-white text-right">{children}</span>
    </div>
  );
}

function LiveCompass() {
  const [heading, setHeading] = useState(null);

  useEffect(() => {
    const handleOrientation = (event) => {
      let compassHeading = event.webkitCompassHeading;

      if (typeof compassHeading !== 'number' || !Number.isFinite(compassHeading)) {
        if (typeof event.alpha !== 'number' || !Number.isFinite(event.alpha)) return;
        compassHeading = 360 - event.alpha;
      }

      setHeading(Math.round((compassHeading + 360) % 360));
    };

    window.addEventListener('deviceorientation', handleOrientation, true);
    return () => window.removeEventListener('deviceorientation', handleOrientation, true);
  }, []);

  return (
    <div className="mb-3 flex flex-col items-center">
      <div className="relative mb-2 h-24 w-24 rounded-full border-2 border-slate-300 bg-slate-100 text-[#0a1128] shadow-[0_0_18px_rgba(125,211,252,0.3)]">
        <span className="absolute left-1/2 top-1 -translate-x-1/2 text-xs font-black">N</span>
        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-xs font-black">E</span>
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-xs font-black">S</span>
        <span className="absolute left-1 top-1/2 -translate-y-1/2 text-xs font-black">W</span>
        <span
          className="absolute inset-0 transition-transform duration-150"
          style={{ transform: `rotate(${heading === null ? 0 : -heading}deg)` }}
        >
          <span className="absolute left-1/2 top-1/2 h-[38%] w-3 -translate-x-1/2 -translate-y-full bg-rose-600 [clip-path:polygon(50%_0,100%_100%,0_100%)]" />
          <span className="absolute left-1/2 top-1/2 h-[38%] w-3 -translate-x-1/2 bg-slate-700 [clip-path:polygon(0_0,100%_0,50%_100%)]" />
        </span>
        <span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#0a1128]" />
      </div>
      <div className="text-xs font-bold tracking-widest text-cyan-300">
        LIVE COMPASS {heading !== null ? `${heading}°` : 'WAITING'}
      </div>
    </div>
  );
}

export default function AmbulancePage() {
  const [gpsStatus, setGpsStatus] = useState('idle'); // idle | active | error | denied
  const [position, setPosition] = useState(null); // { latitude, longitude, accuracy, heading, speed }
  const [backendStatus, setBackendStatus] = useState('unknown'); // connected | disconnected | unknown
  // emergencyRequested: driver pressed Start -- never gated by distance.
  // signalPriority: server-computed, true only inside the trigger/exit zone.
  const [emergencyRequested, setEmergencyRequested] = useState(false);
  const [signalName, setSignalName] = useState('Prototype Junction');
  const [signalLocation, setSignalLocation] = useState(null);
  const [direction, setDirection] = useState(null);
  const [directionSource, setDirectionSource] = useState(null);
  const [directionLocked, setDirectionLocked] = useState(false);
  const [distance, setDistance] = useState(null);
  const [signalPriority, setSignalPriority] = useState(false);
  const [startMessage, setStartMessage] = useState(null);
  const [lastSendTime, setLastSendTime] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const positionRef = useRef(null);

  // Tick once a second just to re-evaluate the "GPS connection lost" banner.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Initial backend reachability check.
  useEffect(() => {
    axios
      .get(`${API_BASE_URL}/api/health`, { timeout: 5000 })
      .then(() => setBackendStatus('connected'))
      .catch(() => setBackendStatus('disconnected'));
  }, []);

  // Continuous GPS tracking via watchPosition (never poll manually).
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsStatus('error');
      return undefined;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy, heading, speed } = pos.coords;
        // Browser heading/speed are null when the device is stationary or
        // the platform doesn't support them -- the backend already falls
        // back to position-based direction in that case. speed arrives in
        // m/s; the backend's MIN_HEADING_SPEED_KMH threshold is km/h.
        const speedKmh = typeof speed === 'number' && Number.isFinite(speed) ? speed * 3.6 : null;
        const headingDeg = typeof heading === 'number' && Number.isFinite(heading) ? heading : null;
        positionRef.current = { latitude, longitude, accuracy, heading: headingDeg, speed: speedKmh };
        setPosition({ latitude, longitude, accuracy, heading: headingDeg, speed: speedKmh });
        setGpsStatus('active');
      },
      (err) => {
        setGpsStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'error');
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Periodic GPS update to Express (fixed interval, not tied to how often
  // watchPosition fires).
  useEffect(() => {
    const interval = setInterval(async () => {
      const pos = positionRef.current;
      if (!pos) return;
      try {
        const result = await sendLocation({
          ambulanceId: AMBULANCE_ID,
          latitude: pos.latitude,
          longitude: pos.longitude,
          accuracy: pos.accuracy,
          heading: pos.heading,
          speed: pos.speed,
        });
        setBackendStatus('connected');
        setLastSendTime(Date.now());
        setDirection(result.direction);
        setDirectionSource(result.directionSource);
        setDirectionLocked(!!result.directionLocked);
        setDistance(result.distance);
        setSignalPriority(result.signalPriority);
        if (typeof result.signalLatitude === 'number' && typeof result.signalLongitude === 'number') {
          setSignalLocation({ latitude: result.signalLatitude, longitude: result.signalLongitude });
        }
        // Backend is the sole authority on emergencyRequested -- e.g. the
        // GPS watchdog auto-clears it after a connection drop, and the UI
        // must reflect that immediately rather than waiting for Stop.
        setEmergencyRequested(result.emergencyRequested);
        if (result.signalName) setSignalName(result.signalName);
      } catch {
        setBackendStatus('disconnected');
      }
    }, GPS_UPDATE_INTERVAL);

    return () => clearInterval(interval);
  }, []);

  const gpsConnectionLost =
    emergencyRequested && lastSendTime !== null && now - lastSendTime > GPS_TIMEOUT_MS;

  // Unconditional: this only flags the request on the backend and starts
  // the location-posting loop feeding it. It is NEVER blocked by distance
  // or by not having a GPS fix yet -- signal priority is decided later,
  // independently, once location updates put the ambulance in range.
  const handleStart = async () => {
    setBusy(true);
    setStartMessage(null);
    try {
      const result = await startEmergency(AMBULANCE_ID);
      setBackendStatus('connected');
      if (result.success) {
        setEmergencyRequested(true);
        setSignalPriority(result.signalPriority);
        setDirection(result.direction);
        setDistance(result.distance);
        if (typeof result.signalLatitude === 'number' && typeof result.signalLongitude === 'number') {
          setSignalLocation({ latitude: result.signalLatitude, longitude: result.signalLongitude });
        }
        setLastSendTime(Date.now());
      } else {
        setStartMessage(result.message || 'Emergency could not be started.');
      }
    } catch {
      setBackendStatus('disconnected');
      alert('Could not reach the traffic backend. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      await stopEmergency(AMBULANCE_ID);
      setBackendStatus('connected');
    } catch {
      setBackendStatus('disconnected');
    } finally {
      setEmergencyRequested(false);
      setSignalPriority(false);
      setBusy(false);
    }
  };

  const gpsLabel = {
    idle: { text: 'CONNECTING...', color: 'text-amber-400' },
    active: { text: 'ACTIVE', color: 'text-emerald-400' },
    error: { text: 'GPS ERROR', color: 'text-rose-400' },
    denied: { text: 'GPS PERMISSION DENIED', color: 'text-rose-400' },
  }[gpsStatus];

  return (
    <div className="min-h-screen bg-[#0a1128] text-white flex flex-col items-center px-4 py-6 sm:py-10">
      <div className="w-full max-w-md">
        {/* Header */}
        <div
          className={`rounded-2xl p-5 text-center mb-5 border-2 transition-colors duration-300 ${
            signalPriority
              ? 'bg-red-600/20 border-red-500 shadow-[0_0_25px_rgba(239,68,68,0.35)]'
              : emergencyRequested
              ? 'bg-amber-500/10 border-amber-400/60'
              : 'bg-[#111a3a] border-yellow-400/40'
          }`}
        >
          <LiveCompass />
          <div className="text-3xl mb-1">{signalPriority ? '🚨' : emergencyRequested ? '🚑' : '🚑'}</div>
          <h1 className="text-lg font-extrabold tracking-wide">
            {signalPriority ? 'SIGNAL PRIORITY ACTIVE' : emergencyRequested ? 'EMERGENCY REQUESTED' : 'SMART EMS'}
          </h1>
          <p className="text-xs text-slate-400 mt-1">Ambulance Driver Console</p>
        </div>

        {gpsConnectionLost && (
          <div className="mb-4 rounded-xl border border-amber-400/60 bg-amber-500/10 text-amber-300 text-xs font-semibold px-4 py-3 text-center">
            ⚠ GPS CONNECTION LOST
          </div>
        )}

        {/* Priority status -- backend-authoritative, updates every
            GPS_UPDATE_INTERVAL. emergencyRequested is never distance-gated;
            signalPriority only turns on once inside the trigger/exit zone. */}
        <div
          className={`mb-4 rounded-xl border px-4 py-3 text-center text-sm font-semibold ${
            signalPriority
              ? 'border-red-500 bg-red-500/10 text-red-400'
              : emergencyRequested
              ? 'border-amber-400 bg-amber-500/10 text-amber-300'
              : 'border-slate-700 bg-slate-800/40 text-slate-400'
          }`}
        >
          {signalPriority
            ? `🚨 Signal priority active — ${direction ? direction.toUpperCase() : ''} GREEN`
            : emergencyRequested
            ? `🚑 Emergency requested — approaching (${distance !== null ? `${distance} m` : 'locating'})`
            : '🚫 No emergency requested'}
        </div>

        {startMessage && !emergencyRequested && (
          <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-300 text-xs font-semibold px-4 py-3 text-center">
            {startMessage}
          </div>
        )}

        {/* Status card */}
        <div className="rounded-2xl bg-[#111a3a] border border-white/10 p-5 mb-5">
          <StatusRow label="Ambulance ID">{AMBULANCE_ID}</StatusRow>
          <StatusRow label="GPS">
            <span className={gpsLabel.color}>
              {gpsStatus === 'active' ? '🟢' : '🔴'} {gpsLabel.text}
            </span>
          </StatusRow>
          <StatusRow label="Backend">
            <span className={backendStatus === 'connected' ? 'text-emerald-400' : 'text-rose-400'}>
              {backendStatus === 'connected' ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}
            </span>
          </StatusRow>
          <StatusRow label="Latitude">{position ? position.latitude.toFixed(6) : '--'}</StatusRow>
          <StatusRow label="Longitude">{position ? position.longitude.toFixed(6) : '--'}</StatusRow>
          <StatusRow label="Accuracy">{position ? `${Math.round(position.accuracy)} m` : '--'}</StatusRow>
          <StatusRow label="Nearest Signal">{signalName}</StatusRow>
          <StatusRow label="Signal Latitude">
            {signalLocation ? signalLocation.latitude.toFixed(6) : '--'}
          </StatusRow>
          <StatusRow label="Signal Longitude">
            {signalLocation ? signalLocation.longitude.toFixed(6) : '--'}
          </StatusRow>
          <StatusRow label="Distance">{distance !== null ? `${distance} m` : '--'}</StatusRow>
          <StatusRow label="Emergency Requested">
            {emergencyRequested ? <span className="text-amber-400">🟠 YES</span> : 'NO'}
          </StatusRow>
          <StatusRow label="Signal Priority">
            {signalPriority ? (
              <span className="text-emerald-400">🟢 {direction?.toUpperCase()} GREEN</span>
            ) : emergencyRequested ? (
              <span className="text-amber-300">WAITING FOR RANGE</span>
            ) : (
              'NORMAL TRAFFIC'
            )}
          </StatusRow>
        </div>

        {/* Action button -- never disabled by GPS distance or fix status.
            Pressing it just flags the request and starts location posting;
            the backend decides when that turns into real signal priority. */}
        {!emergencyRequested ? (
          <button
            onClick={handleStart}
            disabled={busy}
            className="w-full py-4 rounded-2xl font-extrabold tracking-wide text-base bg-yellow-400 text-[#0a1128] disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-transform shadow-[0_0_20px_rgba(250,204,21,0.3)]"
          >
            START EMERGENCY
          </button>
        ) : (
          <button
            onClick={handleStop}
            disabled={busy}
            className="w-full py-4 rounded-2xl font-extrabold tracking-wide text-base bg-red-600 text-white disabled:opacity-40 active:scale-95 transition-transform shadow-[0_0_20px_rgba(220,38,38,0.4)]"
          >
            STOP EMERGENCY
          </button>
        )}

        {gpsStatus !== 'active' && (
          <p className="text-center text-[11px] text-slate-500 mt-3">
            GPS fix not acquired yet -- you can still press Start; tracking will begin as soon as a fix arrives.
          </p>
        )}
      </div>
    </div>
  );
}
