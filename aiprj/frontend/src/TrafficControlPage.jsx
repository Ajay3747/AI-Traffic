import { useState } from 'react';
import {
  clearAdminTrafficDirection,
  setAdminAllRed,
  setAdminTrafficDirection,
} from './services/ambulanceApi';

const DIRECTIONS = ['North', 'East', 'South', 'West'];

export default function TrafficControlPage() {
  const [activeDirection, setActiveDirection] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const selectDirection = async (direction) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await setAdminTrafficDirection(direction);
      setActiveDirection(direction);
      setMessage(
        result.ambulancePriority
          ? `${direction} light is GREEN (admin override; ambulance waiting)`
          : `${direction} light is GREEN`
      );
    } catch {
      setMessage('Traffic light control failed');
    } finally {
      setBusy(false);
    }
  };

  const clearDirection = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await clearAdminTrafficDirection();
      setActiveDirection(null);
      setMessage(
        result.ambulancePriority
          ? 'Admin override cleared; ambulance light restored'
          : 'Admin override cleared; normal traffic restored'
      );
    } catch {
      setMessage('Traffic light control failed');
    } finally {
      setBusy(false);
    }
  };

  const setAllRed = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await setAdminAllRed();
      setActiveDirection(null);
      setMessage('ALL RED override active');
    } catch {
      setMessage('Traffic light control failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0a1128] px-4 py-8 text-white sm:py-12">
      <section className="mx-auto w-full max-w-md">
        <header className="mb-5 rounded-2xl border-2 border-cyan-300/30 bg-[#111a3a] p-6 text-center">
          <div className="mb-2 text-4xl">🚦</div>
          <h1 className="text-xl font-extrabold tracking-wide">TRAFFIC LIGHT CONTROL</h1>
          <p className="mt-2 text-xs text-slate-400">Prototype junction manual control</p>
        </header>

        <section className="rounded-2xl border border-white/10 bg-[#111a3a] p-4">
          <div className="mb-4 grid grid-cols-2 gap-3">
            {DIRECTIONS.map((direction) => (
              <button
                key={direction}
                type="button"
                onClick={() => selectDirection(direction)}
                disabled={busy}
                className={`rounded-xl border px-3 py-5 text-sm font-extrabold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  activeDirection === direction
                    ? 'border-emerald-300 bg-emerald-500 text-[#071326]'
                    : 'border-slate-600 bg-slate-900/60 text-white active:bg-emerald-700'
                }`}
              >
                <span className="mr-1">●</span>
                {direction.toUpperCase()}
                <span className="mt-1 block text-[10px] font-semibold opacity-70">
                  {activeDirection === direction ? 'GREEN ACTIVE' : 'SET GREEN'}
                </span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={clearDirection}
            disabled={busy}
            className="w-full rounded-xl border border-rose-300/40 bg-rose-500/10 px-3 py-3 text-xs font-extrabold text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            CLEAR MANUAL LIGHT
          </button>

          <button
            type="button"
            onClick={setAllRed}
            disabled={busy}
            className="mt-2 w-full rounded-xl border border-red-200 bg-red-700 px-3 py-3 text-xs font-extrabold text-white shadow-[0_0_16px_rgba(185,28,28,0.35)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            FORCE ALL RED
          </button>

          {message && <p className="mt-3 text-center text-xs font-semibold text-cyan-300">{message}</p>}
        </section>
      </section>
    </main>
  );
}
