import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from './config';
import { startEmergency, sendLocation, stopEmergency } from './services/ambulanceApi';

// Fixed for this prototype -- multi-ambulance management is a future
// enhancement, not needed for the demo.
const AMBULANCE_ID = 'AMB-001';

// How often the phone's GPS position is POSTed to the backend. watchPosition
// itself may fire much more often; we only forward at this cadence.
const GPS_UPDATE_INTERVAL = 5000;

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

export default function AmbulancePage() {
  const [gpsStatus, setGpsStatus] = useState('idle'); // idle | active | error | denied
  const [position, setPosition] = useState(null); // { latitude, longitude, accuracy }
  const [backendStatus, setBackendStatus] = useState('unknown'); // connected | disconnected | unknown
  const [emergency, setEmergency] = useState(false);
  const [signalName, setSignalName] = useState('Prototype Junction');
  const [direction, setDirection] = useState(null);
  const [distance, setDistance] = useState(null);
  const [insideGeofence, setInsideGeofence] = useState(false);
  const [signalPriority, setSignalPriority] = useState(false);
  const [startMessage, setStartMessage] = useState(null);
  const [lastSendTime, setLastSendTime] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const positionRef = useRef(null);
  const emergencyRef = useRef(false);

  useEffect(() => {
    emergencyRef.current = emergency;
  }, [emergency]);

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
        const { latitude, longitude, accuracy } = pos.coords;
        positionRef.current = { latitude, longitude, accuracy };
        setPosition({ latitude, longitude, accuracy });
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
          emergency: emergencyRef.current,
        });
        setBackendStatus('connected');
        setLastSendTime(Date.now());
        setDirection(result.direction);
        setDistance(result.distance);
        setInsideGeofence(!!result.insideGeofence);
        setSignalPriority(result.signalPriority);
        // Backend is the sole authority on emergency state -- e.g. it
        // auto-revokes this if the ambulance has left the geofence, and the
        // UI must reflect that immediately rather than waiting for Stop.
        setEmergency(result.emergency);
        if (result.signalName) setSignalName(result.signalName);
      } catch (err) {
        setBackendStatus('disconnected');
      }
    }, GPS_UPDATE_INTERVAL);

    return () => clearInterval(interval);
  }, []);

  const gpsConnectionLost =
    emergency && lastSendTime !== null && now - lastSendTime > GPS_TIMEOUT_MS;

  // The backend independently re-verifies GPS + geofence before granting
  // anything -- pressing this button does not activate priority by itself.
  // A rejection (outside geofence, or no GPS fix yet) comes back as
  // success:false and must NOT flip the UI into emergency mode.
  const handleStart = async () => {
    setBusy(true);
    setStartMessage(null);
    try {
      const result = await startEmergency(AMBULANCE_ID);
      setBackendStatus('connected');
      if (result.success) {
        setEmergency(true);
        setInsideGeofence(!!result.insideGeofence);
        setSignalPriority(result.signalPriority);
        setDirection(result.direction);
        setDistance(result.distance);
        setLastSendTime(Date.now());
      } else {
        setEmergency(false);
        setSignalPriority(false);
        setInsideGeofence(!!result.insideGeofence);
        setStartMessage(result.message || 'Emergency could not be started.');
      }
    } catch (err) {
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
    } catch (err) {
      setBackendStatus('disconnected');
    } finally {
      setEmergency(false);
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
            emergency
              ? 'bg-red-600/20 border-red-500 shadow-[0_0_25px_rgba(239,68,68,0.35)]'
              : 'bg-[#111a3a] border-yellow-400/40'
          }`}
        >
          <div className="text-3xl mb-1">{emergency ? '🚨' : '🚑'}</div>
          <h1 className="text-lg font-extrabold tracking-wide">
            {emergency ? 'EMERGENCY ACTIVE' : 'SMART EMS'}
          </h1>
          <p className="text-xs text-slate-400 mt-1">Ambulance Driver Console</p>
        </div>

        {gpsConnectionLost && (
          <div className="mb-4 rounded-xl border border-amber-400/60 bg-amber-500/10 text-amber-300 text-xs font-semibold px-4 py-3 text-center">
            ⚠ GPS CONNECTION LOST
          </div>
        )}

        {/* Geofence / priority status -- backend-authoritative, updates every
            GPS_UPDATE_INTERVAL regardless of whether Start has been pressed */}
        <div
          className={`mb-4 rounded-xl border px-4 py-3 text-center text-sm font-semibold ${
            emergency
              ? 'border-red-500 bg-red-500/10 text-red-400'
              : insideGeofence
              ? 'border-emerald-400 bg-emerald-500/10 text-emerald-300'
              : 'border-slate-700 bg-slate-800/40 text-slate-400'
          }`}
        >
          {emergency
            ? `🚨 Emergency active — ${direction ? direction.toUpperCase() : ''} signal priority`
            : insideGeofence
            ? '🚨 Emergency priority available'
            : '🚫 Emergency unavailable — enter signal range'}
        </div>

        {startMessage && !emergency && (
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
          <StatusRow label="Distance">{distance !== null ? `${distance} m` : '--'}</StatusRow>
          <StatusRow label="Approaching From">{direction ? direction.toUpperCase() : '--'}</StatusRow>
          <StatusRow label="Emergency">
            {emergency ? <span className="text-red-500">🔴 ACTIVE</span> : 'INACTIVE'}
          </StatusRow>
          <StatusRow label="Signal Priority">
            {emergency ? (
              <span className="text-emerald-400">🟢 {direction?.toUpperCase()} GREEN</span>
            ) : insideGeofence ? (
              <span className="text-emerald-300">AVAILABLE</span>
            ) : (
              'NORMAL TRAFFIC'
            )}
          </StatusRow>
        </div>

        {/* Action button */}
        {!emergency ? (
          <button
            onClick={handleStart}
            disabled={busy || gpsStatus !== 'active' || !insideGeofence}
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
            Waiting for a valid GPS fix before emergency mode can be started.
          </p>
        )}
        {gpsStatus === 'active' && !emergency && !insideGeofence && (
          <p className="text-center text-[11px] text-slate-500 mt-3">
            Move within the signal's geofence range to enable Start Emergency.
          </p>
        )}
      </div>
    </div>
  );
}
