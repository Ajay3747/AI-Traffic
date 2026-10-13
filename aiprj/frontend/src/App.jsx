import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload, Clock, CheckCircle,
  RefreshCw, Activity, Video, ShieldAlert, Check
} from 'lucide-react';
import { uploadVideo, analyzeTraffic, startSignalCycle, getSignalStatus, resetSignalCycle } from './services/api';

const ROADS = ['North', 'South', 'East', 'West'];
// Matches YELLOW_WARNING_SECONDS in the ESP32 firmware so the simulator UI
// and the physical lights change to yellow at the same countdown value.
const YELLOW_WARNING_SECONDS = 7;
const ROAD_LABELS = {
  North: 'North (Main Ave)',
  South: 'South (Expressway)',
  East: 'East (Broadway)',
  West: 'West (Ring Road)'
};

const WORKFLOW_STEPS = [
  'Uploading video files to media gateway...',
  'Initializing YOLOv8 vehicle detection model...',
  'Processing frame-sampled object recognition...',
  'Compiling traffic density estimations...',
  'Executing priority green signal assignment...',
  'Synchronizing four-way crossroads lights...'
];

export default function App() {
  // Video upload states for each road
  const [videoData, setVideoData] = useState({
    North: { file: null, preview: null, status: 'idle', serverPath: null, error: null },
    South: { file: null, preview: null, status: 'idle', serverPath: null, error: null },
    East: { file: null, preview: null, status: 'idle', serverPath: null, error: null },
    West: { file: null, preview: null, status: 'idle', serverPath: null, error: null },
  });

  // Analysis and Simulation states
  const [analysisStatus, setAnalysisStatus] = useState('idle'); // idle, processing, completed
  const [workflowStepIdx, setWorkflowStepIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [analysisElapsedSec, setAnalysisElapsedSec] = useState(0);
  const [vehicleCounts, setVehicleCounts] = useState(null);
  const [activeRoad, setActiveRoad] = useState(null);
  const [servedRoads, setServedRoads] = useState([]);
  const [timerRemaining, setTimerRemaining] = useState(0);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationFinished, setSimulationFinished] = useState(false);
  const [isMockResult, setIsMockResult] = useState(false);
  const [direction, setDirection] = useState('clockwise'); // clockwise or anticlockwise

  // True when the active road's light should show yellow instead of green,
  // matching YELLOW_WARNING_SECONDS in the ESP32 firmware.
  const isYellowPhase = isSimulating && timerRemaining > 0 && timerRemaining <= YELLOW_WARNING_SECONDS;

  // Live wall-clock display in the header -- purely cosmetic (no backend
  // call), just ticks locally so the dashboard reads as a real-time console.
  const [clockNow, setClockNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setClockNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // File input refs
  const fileInputRefs = {
    North: useRef(null),
    South: useRef(null),
    East: useRef(null),
    West: useRef(null),
  };

  // Video element refs for synchronized playback. Each useRef must be
  // called at the top level (not inside useMemo) per Rules of Hooks, but
  // the lookup object wrapping them is memoized so its identity stays
  // stable across renders -- otherwise the auto-play effect below would
  // need to either re-run on every render or lie about its dependencies.
  const videoRefNorth = useRef(null);
  const videoRefSouth = useRef(null);
  const videoRefEast = useRef(null);
  const videoRefWest = useRef(null);
  const videoRefs = useMemo(() => ({
    North: videoRefNorth,
    South: videoRefSouth,
    East: videoRefEast,
    West: videoRefWest,
  }), []);

  // Handle file selection
  const handleFileChange = async (road, file) => {
    if (!file) return;

    // Reset counts & states on new file upload
    setVehicleCounts(null);
    setActiveRoad(null);
    setServedRoads([]);
    setIsSimulating(false);
    setSimulationFinished(false);
    setAnalysisStatus('idle');

    // Create local object URL for instant preview
    const previewUrl = URL.createObjectURL(file);
    
    setVideoData(prev => ({
      ...prev,
      [road]: {
        ...prev[road],
        file,
        preview: previewUrl,
        status: 'uploading',
        serverPath: null,
        error: null
      }
    }));

    try {
      const response = await uploadVideo(file, road);
      if (response.success) {
        setVideoData(prev => ({
          ...prev,
          [road]: {
            ...prev[road],
            status: 'success',
            serverPath: response.path
          }
        }));
      } else {
        throw new Error(response.message || 'Upload failed');
      }
    } catch (err) {
      console.error(err);
      const errorMessage = err.response?.data?.message || err.message || 'File upload failed';
      setVideoData(prev => ({
        ...prev,
        [road]: {
          ...prev[road],
          status: 'error',
          error: errorMessage
        }
      }));
    }
  };

  const triggerUpload = (road) => {
    fileInputRefs[road].current?.click();
  };

  // Drag and Drop helpers
  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDrop = (e, road) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileChange(road, file);
    }
  };

  // Auto-play videos during active state
  useEffect(() => {
    ROADS.forEach(road => {
      const videoEl = videoRefs[road].current;
      if (videoEl) {
        if (activeRoad === road && isSimulating) {
          videoEl.play().catch(() => {});
        } else {
          videoEl.pause();
        }
      }
    });
  }, [activeRoad, isSimulating, videoRefs]);

  // Start traffic analysis
  const handleAnalyze = async () => {
    // Check if all four videos are uploaded
    const missingRoads = ROADS.filter(road => !videoData[road].serverPath);
    if (missingRoads.length > 0) {
      alert(`Please upload traffic videos for all four roads first. Missing: ${missingRoads.join(', ')}`);
      return;
    }

    setAnalysisStatus('processing');
    setWorkflowStepIdx(0);
    setProgress(5);
    setAnalysisElapsedSec(0);
    setSimulationFinished(false);
    setServedRoads([]);
    setActiveRoad(null);

    // Prepare path data for backend
    const videosPayload = {};
    ROADS.forEach(road => {
      videosPayload[road] = videoData[road].serverPath;
    });

    // Real YOLOv8 detection+tracking over 4 videos on the CPU can take
    // several minutes. The progress bar and status text must keep visibly
    // moving for the ENTIRE wait -- capping at a fixed value and freezing
    // the last step's text (the old behavior) is indistinguishable from a
    // crash once a real analysis runs past the few seconds this animation
    // was tuned for.
    const progressInterval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 99) return 99;
        // Slows down the closer it gets to 99 so it never visibly stalls.
        const step = prev < 90 ? Math.random() * 4 + 2 : Math.random() * 0.6 + 0.1;
        return Math.min(99, prev + step);
      });
    }, 400);

    const stepInterval = setInterval(() => {
      // Cycle through the remaining "in progress" steps indefinitely
      // (excluding the final "done" step, which only shows on completion)
      // instead of stopping on the last one and sitting there silently.
      setWorkflowStepIdx(prev => (prev + 1) % (WORKFLOW_STEPS.length - 1));
    }, 1800);

    const elapsedInterval = setInterval(() => {
      setAnalysisElapsedSec(prev => prev + 1);
    }, 1000);

    try {
      // Trigger actual AI analysis
      const result = await analyzeTraffic(videosPayload);

      // Complete the loading transition
      clearInterval(progressInterval);
      clearInterval(stepInterval);
      clearInterval(elapsedInterval);
      setProgress(100);
      setWorkflowStepIdx(WORKFLOW_STEPS.length - 1);

      setTimeout(() => {
        setVehicleCounts(result.counts);
        setIsMockResult(result.isMock || false);
        setAnalysisStatus('completed');

        // Start simulation immediately after analysis
        startSimulation(result.counts);
      }, 800);

    } catch (err) {
      console.error(err);
      clearInterval(progressInterval);
      clearInterval(stepInterval);
      clearInterval(elapsedInterval);
      const backendMessage = err.response?.data?.message;
      const timedOut = err.code === 'ECONNABORTED';
      alert(
        backendMessage ||
        (timedOut
          ? 'Analysis timed out after 15 minutes. The AI service may be stuck; please check the backend and try again.'
          : 'An error occurred during analysis. Make sure the backend server is running.')
      );
      setAnalysisStatus('idle');
    }
  };

  // Helper to determine congestion level
  const getCongestionLevel = (count) => {
    if (count <= 20) return { label: 'LOW', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' };
    if (count <= 50) return { label: 'MEDIUM', color: 'text-amber-400 bg-amber-500/10 border-amber-500/30' };
    return { label: 'HIGH', color: 'text-rose-400 bg-rose-500/10 border-rose-500/30' };
  };

  // Helper to determine green light duration based on vehicle counts
  const getGreenDuration = (count) => {
    if (count <= 20) return 15;
    if (count <= 50) return 30;
    if (count <= 80) return 45;
    return 60;
  };

  // Initialize and start signal switching cycle on the server.
  // The Express backend owns the actual countdown/emergency-preemption state now,
  // so the browser UI and any external IoT module (e.g. an ESP32 driving real
  // lights) both just poll GET /api/signal/status and stay in sync.
  const startSimulation = async (counts, dir = direction) => {
    setSimulationFinished(false);
    try {
      const { state } = await startSignalCycle(counts, dir);
      setDirection(state.direction);
      setActiveRoad(state.activeRoad);
      setServedRoads(state.servedRoads);
      setTimerRemaining(state.timerRemaining);
      setIsSimulating(state.isSimulating);
    } catch (err) {
      console.error('Failed to start signal cycle:', err);
    }
  };

  // On first load (or a page refresh), the backend may already have a signal
  // cycle running or just-finished -- e.g. the ESP32 is actively driving
  // lights from a simulation this browser tab never saw. Without this, local
  // state always starts at the "awaiting uploads" defaults regardless of
  // what the backend/ESP32 are actually doing, which looks like stale/wrong
  // data. Fetch the real state once on mount and rehydrate from it.
  useEffect(() => {
    (async () => {
      try {
        const { state } = await getSignalStatus();
        setDirection(state.direction);
        setActiveRoad(state.activeRoad);
        setServedRoads(state.servedRoads);
        setTimerRemaining(state.timerRemaining);
        setIsSimulating(state.isSimulating);
        setSimulationFinished(state.simulationFinished);
        if (state.vehicleCounts) {
          setVehicleCounts(state.vehicleCounts);
          setAnalysisStatus('completed');
        }
      } catch (err) {
        console.error('Failed to fetch initial signal status:', err);
      }
    })();
  }, []);

  // Poll the server for the live signal state while a cycle is running
  useEffect(() => {
    if (!isSimulating) return undefined;

    const interval = setInterval(async () => {
      try {
        const { state } = await getSignalStatus();
        setActiveRoad(state.activeRoad);
        setServedRoads(state.servedRoads);
        setTimerRemaining(state.timerRemaining);
        setIsSimulating(state.isSimulating);
        if (state.simulationFinished) {
          setSimulationFinished(true);
        }
      } catch (err) {
        console.error('Failed to poll signal status:', err);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isSimulating]);

  // Format timer into MM:SS
  const formatTime = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Reset the system simulation, optionally switching cycle direction
  const handleResetSimulation = async (dir = direction) => {
    setIsSimulating(false);
    setServedRoads([]);
    setActiveRoad(null);
    setTimerRemaining(0);
    setSimulationFinished(false);
    try {
      await resetSignalCycle();
    } catch (err) {
      console.error('Failed to reset signal cycle:', err);
    }
    if (vehicleCounts) {
      startSimulation(vehicleCounts, dir);
    }
  };

  const allUploaded = ROADS.every(road => videoData[road].serverPath);

  return (
    <div className="min-h-screen ops-grid-bg bg-[#070a13] bg-radial-[circle_at_center,_var(--tw-gradient-stops)] from-[#0f172a] via-[#070a13] to-[#030712] py-8 px-4 sm:px-6 lg:px-8 text-slate-200">
      
      {/* 1. Header Area */}
      <header className="max-w-7xl mx-auto mb-8 flex flex-col md:flex-row items-center justify-between border-b border-slate-800/60 pb-6">
        <div className="flex items-center space-x-4 mb-4 md:mb-0">
          <div className="h-12 w-12 rounded-xl bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.2)]">
            <Activity className="h-6 w-6 animate-pulse" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl bg-gradient-to-r from-blue-400 via-indigo-200 to-purple-400 bg-clip-text text-transparent">
              AI SMART TRAFFIC CONTROL SYSTEM
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Next-Generation Urban Traffic Optimization Terminal
            </p>
          </div>
        </div>

        {/* Live HUD Status */}
        <div className="flex flex-col items-end space-y-2">
          <div className="flex items-center space-x-3 bg-slate-900/60 border border-slate-800/80 rounded-full px-4 py-2 text-xs">
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isSimulating ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${isSimulating ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
            </span>
            <span className="font-mono text-slate-300">
              SYSTEM STATUS: {isSimulating ? 'SIMULATION ACTIVE' : 'AWAITING UPLOADS'}
            </span>
          </div>
          <div className="flex items-center space-x-2 px-1 text-[11px] font-mono text-slate-500 tabular-nums">
            <span className="text-slate-600">{clockNow.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <span className="h-1 w-1 rounded-full bg-slate-700" />
            <span className="text-slate-400">{clockNow.toLocaleTimeString(undefined, { hour12: false })}</span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto space-y-8">
        
        {/* 2. Upload Area */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white flex items-center space-x-2">
              <Video className="h-5 w-5 text-blue-400" />
              <span>Multi-Directional Video Feeds</span>
            </h2>
            <span className="text-xs text-slate-400">Supported formats: MP4, MOV, WEBM (Max 100MB)</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {ROADS.map(road => {
              const data = videoData[road];
              const isProcessing = data.status === 'uploading';
              const isSuccess = data.status === 'success';
              const isError = data.status === 'error';
              const hasFile = data.preview !== null;
              const hasEmergency = vehicleCounts?.[road]?.emergency;

              return (
                <div 
                  key={road}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, road)}
                  className={`relative group rounded-2xl glass-panel p-4 flex flex-col h-[280px] justify-between transition-all duration-300 ${
                    hasEmergency
                      ? 'border-red-500/70 shadow-[0_0_25px_rgba(239,68,68,0.25)] bg-red-950/5'
                      : activeRoad === road && isSimulating
                      ? 'border-emerald-500/50 shadow-[0_0_20px_rgba(34,197,94,0.15)] bg-emerald-950/5'
                      : activeRoad === road
                      ? 'border-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.15)] bg-blue-950/5'
                      : 'hover:border-slate-700/60 hover:bg-slate-900/30'
                  }`}
                >
                  {/* Card Direction & Status Indicator */}
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-300 tracking-widest uppercase">{road}</span>

                    {/* Tiny Status Dot */}
                    <span className="flex items-center space-x-1.5 text-[10px] font-semibold font-mono tracking-wider uppercase">
                      {isProcessing && (
                        <span className="text-blue-400 flex items-center space-x-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                          <span>Uploading</span>
                        </span>
                      )}
                      {isSuccess && !vehicleCounts && (
                        <span className="text-emerald-400 flex items-center space-x-1">
                          <Check className="h-3 w-3" /> <span>Ready</span>
                        </span>
                      )}
                      {isError && (
                        <span className="text-rose-400 flex items-center space-x-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                          <span>Error</span>
                        </span>
                      )}
                      {data.status === 'idle' && (
                        <span className="text-slate-500 flex items-center space-x-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-slate-700" />
                          <span>Standby</span>
                        </span>
                      )}
                    </span>
                  </div>

                  {/* Drag-Drop / Video Preview Area */}
                  <div className="flex-1 w-full rounded-xl overflow-hidden bg-slate-950/80 border border-slate-800/80 flex flex-col items-center justify-center relative">
                    {hasFile ? (
                      <video 
                        ref={videoRefs[road]}
                        src={data.preview}
                        className="w-full h-full object-cover"
                        loop
                        muted
                        playsInline
                        controls
                      />
                    ) : (
                      <div 
                        onClick={() => triggerUpload(road)}
                        className="cursor-pointer w-full h-full flex flex-col items-center justify-center p-6 text-center group-hover:bg-slate-900/10 transition-colors"
                      >
                        <div className="h-10 w-10 rounded-full bg-slate-900 border border-slate-800/80 flex items-center justify-center text-slate-400 mb-2 group-hover:text-blue-400 group-hover:border-blue-500/30 transition-all duration-300">
                          <Upload className="h-5 w-5" />
                        </div>
                        <span className="text-xs font-semibold text-slate-300 group-hover:text-blue-400 transition-colors">
                          Click to Upload Video
                        </span>
                        <span className="text-[10px] text-slate-500 mt-1">
                          or drag & drop here
                        </span>
                      </div>
                    )}

                    {/* Emergency Alert Banner */}
                    {vehicleCounts && vehicleCounts[road]?.emergency && (
                      <div className="absolute inset-x-3 top-3 bg-red-600/90 border border-red-500 text-white font-mono text-[10px] font-bold py-1.5 px-3 rounded-lg flex items-center justify-center space-x-2 animate-pulse shadow-lg z-20">
                        <ShieldAlert className="h-3.5 w-3.5 animate-spin" style={{ animationDuration: '3s' }} />
                        <span>AMBULANCE DETECTED</span>
                      </div>
                    )}

                    {/* Floating Overlay Traffic Light Widget */}
                    {vehicleCounts && (
                      <div className="absolute top-2.5 right-2.5 bg-slate-950/90 border border-slate-850 p-1.5 rounded-lg flex flex-col space-y-1.5 z-10 shadow-xl">
                        {/* Red Node */}
                        <div className={`w-3.5 h-3.5 rounded-full border border-black/50 transition-all duration-300 ${
                          activeRoad === road && isSimulating
                            ? 'bg-red-950/80 border-slate-900'
                            : 'bg-red-500 shadow-[0_0_12px_#ef4444]'
                        }`} />
                        {/* Green Node */}
                        <div className={`w-3.5 h-3.5 rounded-full border border-black/50 transition-all duration-300 ${
                          activeRoad === road && isSimulating
                            ? 'bg-emerald-500 shadow-[0_0_12px_#22c55e]'
                            : 'bg-emerald-950/80 border-slate-900'
                        }`} />
                      </div>
                    )}

                    {/* Masking overlay for processing state */}
                    {isProcessing && (
                      <div className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center space-y-2">
                        <div className="h-8 w-8 rounded-full border-2 border-slate-800 border-t-blue-500 animate-spin"></div>
                        <span className="text-xs font-semibold text-blue-400 tracking-wider">UPLOADING</span>
                      </div>
                    )}
                  </div>

                  {/* Hidden Input */}
                  <input 
                    type="file"
                    ref={fileInputRefs[road]}
                    onChange={(e) => handleFileChange(road, e.target.files?.[0])}
                    accept="video/*"
                    className="hidden"
                  />

                  {/* Footer status text */}
                  <div className="mt-2 text-[10px] text-slate-500 truncate">
                    {isSuccess && `Path: ${data.serverPath}`}
                    {isError && `Failed: ${data.error}`}
                    {data.status === 'idle' && 'Drag a traffic camera video file here.'}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 3. Action Panel & Workflow Animations */}
        <section className="glass-panel rounded-2xl p-6 relative overflow-hidden flex flex-col items-center justify-center text-center">
          
          {analysisStatus === 'idle' && (
            <div className="space-y-4 max-w-xl">
              <h3 className="text-xl font-bold text-white">Execute Intelligent Traffic Analysis</h3>
              <p className="text-sm text-slate-400 leading-relaxed">
                When all 4 cameras are active, the AI engine will parse the video streams using a pre-trained YOLOv8 convolutional neural network to count vehicles in each direction and compute smart light durations.
              </p>

              {/* Feed readiness indicator */}
              <div className="flex items-center justify-center space-x-2 pt-1 pb-1">
                {ROADS.map(road => (
                  <span
                    key={road}
                    className={`h-1.5 w-6 rounded-full transition-colors duration-300 ${
                      videoData[road].serverPath ? 'bg-emerald-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-slate-800'
                    }`}
                  />
                ))}
                <span className="text-[11px] font-mono text-slate-500 pl-1 tabular-nums">
                  {ROADS.filter(road => videoData[road].serverPath).length}/4 FEEDS READY
                </span>
              </div>

              <button
                onClick={handleAnalyze}
                disabled={!allUploaded}
                className={`px-8 py-3.5 rounded-xl font-semibold tracking-wider text-sm flex items-center justify-center space-x-2 transition-all duration-300 ${
                  allUploaded 
                    ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer shadow-[0_0_20px_rgba(59,130,246,0.35)] hover:shadow-[0_0_25px_rgba(59,130,246,0.5)] active:scale-95' 
                    : 'bg-slate-800/80 text-slate-500 border border-slate-700/30 cursor-not-allowed'
                }`}
              >
                <Activity className="h-4 w-4" />
                <span>ANALYZE TRAFFIC FEED</span>
              </button>
            </div>
          )}

          {analysisStatus === 'processing' && (
            <div className="w-full max-w-2xl py-4 space-y-6">
              <div className="flex items-center justify-between text-xs font-mono text-blue-400">
                <span className="flex items-center space-x-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                  </span>
                  <span>AI ENGINE PROCESSING ACTIVE</span>
                </span>
                <span>{Math.round(progress)}% COMPLETE</span>
              </div>

              {/* Progress Bar Container */}
              <div className="w-full h-2.5 bg-slate-950 border border-slate-850 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>

              {/* Animated processing messages */}
              <div className="h-6 overflow-hidden flex justify-center items-center">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={workflowStepIdx}
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -20, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="text-sm font-semibold font-mono text-slate-300 tracking-wide"
                  >
                    {WORKFLOW_STEPS[workflowStepIdx]}
                  </motion.div>
                </AnimatePresence>
              </div>

              <p className="text-center text-xs text-slate-500 font-mono">
                Elapsed: {Math.floor(analysisElapsedSec / 60)}m {String(analysisElapsedSec % 60).padStart(2, '0')}s
                {' '}&mdash; Real YOLOv8 analysis of 4 videos on CPU can take several minutes. This is expected; please don't close this tab.
              </p>
            </div>
          )}

          {analysisStatus === 'completed' && (
            <div className="w-full flex flex-col md:flex-row items-center justify-between md:text-left gap-4">
              <div className="flex items-center space-x-4">
                <div className="h-10 w-10 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <CheckCircle className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-white">Neural Processing Finished</h4>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Analyzed video sample arrays successfully. {isMockResult ? 'Simulated AI response triggered.' : 'Real-time YOLOv8 detections calculated.'}
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-3">
                <button
                  onClick={handleAnalyze}
                  className="px-5 py-2.5 rounded-lg border border-slate-800 hover:border-slate-700 bg-slate-900/60 text-xs font-semibold text-slate-300 hover:text-white transition-all active:scale-95 flex items-center space-x-1.5"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Re-Run AI</span>
                </button>
              </div>
            </div>
          )}
        </section>

        {/* 4. Outputs grid (Traffic Density + AI Decision + Intersection Simulator) */}
        {vehicleCounts && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            {/* Left Column: Density Results & AI Decision (5 columns) */}
            <div className="lg:col-span-5 space-y-6 flex flex-col justify-between">
              
              {/* Traffic Density Results Card */}
              <div className="glass-panel rounded-2xl p-5 space-y-4">
                <h3 className="text-base font-bold text-white border-b border-slate-800/60 pb-3 flex items-center space-x-2">
                  <span className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]"></span>
                  <span>Traffic Density Metrics</span>
                </h3>

                <div className="grid grid-cols-2 gap-4">
                  {ROADS.map(road => {
                    const roadData = vehicleCounts[road];
                    const count = roadData ? (typeof roadData === 'object' ? roadData.count : roadData) : 0;
                    const seconds = roadData ? (typeof roadData === 'object' ? roadData.seconds : getGreenDuration(roadData)) : 15;
                    const level = getCongestionLevel(count);
                    const isActive = activeRoad === road;

                    return (
                      <div 
                        key={road} 
                        className={`p-3.5 rounded-xl border transition-all ${
                          isActive 
                            ? 'bg-blue-950/20 border-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.1)]' 
                            : 'bg-slate-950/40 border-slate-900'
                        }`}
                      >
                        <div className="text-xs text-slate-400 font-semibold mb-1">{road} Road</div>
                        <div className="flex items-baseline justify-between">
                          <span className="text-2xl font-bold font-mono text-white">{count}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-md font-bold border tracking-wider ${level.color}`}>
                            {level.label}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1 font-mono">
                          Timer limit: {seconds}s
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* AI Decision Box */}
              <div className="glass-panel rounded-2xl p-5 border-l-4 border-l-blue-500 bg-gradient-to-r from-blue-950/10 via-transparent to-transparent flex-1 flex flex-col justify-between mt-6 lg:mt-0">
                <div>
                  <div className="flex items-center justify-between border-b border-slate-850 pb-3">
                    <h3 className="text-sm font-bold tracking-wider text-blue-400 uppercase font-mono">
                      AI Priority Decision HUD
                    </h3>
                    <div className="text-[10px] font-mono font-semibold px-2.5 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400">
                      OPTIMIZED
                    </div>
                  </div>

                  <div className="mt-4 space-y-4">
                    {activeRoad ? (
                      (() => {
                        const activeRoadData = vehicleCounts[activeRoad];
                        const activeCount = activeRoadData ? (typeof activeRoadData === 'object' ? activeRoadData.count : activeRoadData) : 0;
                        const activeSeconds = activeRoadData ? (typeof activeRoadData === 'object' ? activeRoadData.seconds : getGreenDuration(activeRoadData)) : 15;
                        const isEmergency = activeRoadData ? (typeof activeRoadData === 'object' ? activeRoadData.emergency : false) : false;
                        return (
                          <div>
                            {isEmergency && (
                              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center space-x-3 text-red-400 mb-4 animate-pulse">
                                <ShieldAlert className="h-5 w-5 text-red-500 animate-bounce" />
                                <div>
                                  <div className="text-xs font-bold uppercase tracking-wider">EMERGENCY PREEMPTION ACTIVE</div>
                                  <div className="text-[10px] opacity-80 mt-0.5">Ambulance detected. Overriding normal cycle sequence.</div>
                                </div>
                              </div>
                            )}

                            <div className="text-xs text-slate-400">Target Road Sector</div>
                            <div className="text-xl font-bold text-white flex items-center space-x-2 mt-1">
                              <span className="relative flex h-2.5 w-2.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                              </span>
                              <span>{ROAD_LABELS[activeRoad]}</span>
                            </div>

                            <div className="grid grid-cols-2 gap-4 mt-4">
                              <div>
                                <span className="text-[10px] text-slate-500 block">Vehicle Count</span>
                                <span className="text-xl font-bold font-mono text-white mt-0.5 block">{activeCount}</span>
                              </div>
                              <div>
                                <span className="text-[10px] text-slate-500 block">Green Signal Assigned</span>
                                <span className="text-xl font-bold font-mono text-emerald-400 mt-0.5 block">{activeSeconds}s</span>
                              </div>
                            </div>

                            <div className="mt-4 p-3 bg-slate-950/40 border border-slate-900 rounded-lg text-xs leading-relaxed text-slate-400">
                              <span className="font-semibold text-slate-300">Decision Rationale: </span>
                              {isEmergency ? (
                                <span className="text-rose-400 font-medium">
                                  Emergency vehicle detected. The system has automatically overridden the standard traffic signal cycle to grant immediate priority green clearance.
                                </span>
                              ) : (
                                <span>
                                  Traffic volume detected ({activeCount} vehicles). Signal transfers in a {direction} sequence starting from North. Green light period of {activeSeconds}s is determined by AI density analysis.
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })()
                    ) : simulationFinished ? (
                      <div className="py-6 text-center space-y-3">
                        <div className="mx-auto h-10 w-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                          <CheckCircle className="h-5 w-5" />
                        </div>
                        <div>
                          <div className="text-sm font-bold text-white">Full Intersection Serviced</div>
                          <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                            All sectors have completed their green-light queue discharge routines. The system is idling.
                          </p>
                        </div>
                        <button
                          onClick={handleResetSimulation}
                          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs active:scale-95 transition-all shadow-[0_0_12px_rgba(59,130,246,0.3)] mt-2"
                        >
                          Restart Cycle Simulation
                        </button>
                      </div>
                    ) : (
                      <div className="py-8 text-center text-xs text-slate-500 font-mono">
                        Awaiting active signal routing sequence...
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: 4-Way Traffic Signal Simulator & Status Panel (7 columns) */}
            <div className="lg:col-span-7 space-y-6 flex flex-col justify-between">
              
              {/* Traffic Signal Simulation Panel */}
              <div className="glass-panel rounded-2xl p-5 space-y-4 flex-1 flex flex-col justify-between">
                <h3 className="text-base font-bold text-white border-b border-slate-800/60 pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <span className="flex items-center space-x-2">
                    <Clock className="h-5 w-5 text-blue-400" />
                    <span>Real-Time Intersection Simulator</span>
                  </span>
                  
                  <div className="flex flex-wrap items-center gap-3">
                    {/* Direction Toggle Control */}
                    <div className="flex items-center space-x-1.5 bg-slate-900/80 border border-slate-800/80 rounded-lg p-0.5">
                      <button
                        onClick={() => handleResetSimulation('clockwise')}
                        className={`px-2.5 py-1 rounded-md text-[10px] uppercase font-mono font-bold tracking-wider transition-all ${
                          direction === 'clockwise'
                            ? 'bg-blue-600 text-white shadow-md'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        CW (Clockwise)
                      </button>
                      <button
                        onClick={() => handleResetSimulation('anticlockwise')}
                        className={`px-2.5 py-1 rounded-md text-[10px] uppercase font-mono font-bold tracking-wider transition-all ${
                          direction === 'anticlockwise'
                            ? 'bg-blue-600 text-white shadow-md'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        CCW (Anticlockwise)
                      </button>
                    </div>

                    {isSimulating && (
                      <span className="font-mono text-xs text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded border border-emerald-500/20 animate-pulse">
                        Time Left: {formatTime(timerRemaining)}
                      </span>
                    )}
                  </div>
                </h3>

                {/* 4-Way Intersection Graphic Design */}
                <div className="flex-1 flex items-center justify-center p-4 min-h-[300px]">
                  <div className="relative w-[280px] h-[280px] bg-slate-950 border border-slate-850 rounded-3xl overflow-hidden shadow-2xl flex items-center justify-center">
                    
                    {/* Road layout markings */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      {/* Vertical Road */}
                      <div className="w-[80px] h-full border-l border-r border-dashed border-slate-800/80 bg-slate-900/35 relative">
                        {/* Center lane divider */}
                        <div className="absolute left-[39px] top-0 bottom-0 w-0.5 border-l border-dashed border-slate-700/80"></div>
                      </div>
                      {/* Horizontal Road */}
                      <div className="absolute h-[80px] w-full border-t border-b border-dashed border-slate-800/80 bg-slate-900/35 flex items-center">
                        {/* Center lane divider */}
                        <div className="absolute top-[39px] left-0 right-0 h-0.5 border-t border-dashed border-slate-700/80"></div>
                      </div>
                      
                      {/* Central crossroads circle */}
                      <div className="absolute h-[110px] w-[110px] rounded-full border border-slate-800 bg-[#0c1222] shadow-[inset_0_0_15px_rgba(0,0,0,0.8)]"></div>
                    </div>

                    {/* ROAD LIGHT NODES */}
                    
                    {/* NORTH LIGHT */}
                    <div className="absolute top-2 left-1/2 transform -translate-x-1/2 flex flex-col items-center z-10">
                      <div className="text-[10px] font-bold text-slate-500 mb-1">NORTH</div>
                      <div className="w-7 h-16 rounded-full bg-slate-900 border border-slate-800 flex flex-col items-center justify-around py-1 shadow-md">
                        {/* Red Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'North'
                            ? 'bg-red-950 border border-red-900/20'
                            : 'bg-red-500 glow-red-active'
                        }`} />
                        {/* Yellow Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'North' && isYellowPhase
                            ? 'bg-yellow-500 glow-yellow-active'
                            : 'bg-yellow-950 border border-yellow-900/20'
                        }`} />
                        {/* Green Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'North' && !isYellowPhase
                            ? 'bg-emerald-500 glow-green-active'
                            : 'bg-emerald-950 border border-emerald-900/20'
                        }`} />
                      </div>
                    </div>

                    {/* SOUTH LIGHT */}
                    <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2 flex flex-col-reverse items-center z-10">
                      <div className="text-[10px] font-bold text-slate-500 mt-1">SOUTH</div>
                      <div className="w-7 h-16 rounded-full bg-slate-900 border border-slate-800 flex flex-col items-center justify-around py-1 shadow-md">
                        {/* Green Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'South' && !isYellowPhase
                            ? 'bg-emerald-500 glow-green-active'
                            : 'bg-emerald-950 border border-emerald-900/20'
                        }`} />
                        {/* Yellow Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'South' && isYellowPhase
                            ? 'bg-yellow-500 glow-yellow-active'
                            : 'bg-yellow-950 border border-yellow-900/20'
                        }`} />
                        {/* Red Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'South'
                            ? 'bg-red-950 border border-red-900/20'
                            : 'bg-red-500 glow-red-active'
                        }`} />
                      </div>
                    </div>

                    {/* EAST LIGHT */}
                    <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center space-x-1.5 z-10">
                      <div className="w-16 h-7 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-around px-1 shadow-md">
                        {/* Red Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'East'
                            ? 'bg-red-950 border border-red-900/20'
                            : 'bg-red-500 glow-red-active'
                        }`} />
                        {/* Yellow Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'East' && isYellowPhase
                            ? 'bg-yellow-500 glow-yellow-active'
                            : 'bg-yellow-950 border border-yellow-900/20'
                        }`} />
                        {/* Green Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'East' && !isYellowPhase
                            ? 'bg-emerald-500 glow-green-active'
                            : 'bg-emerald-950 border border-emerald-900/20'
                        }`} />
                      </div>
                      <div className="text-[10px] font-bold text-slate-500">EAST</div>
                    </div>

                    {/* WEST LIGHT */}
                    <div className="absolute left-2 top-1/2 transform -translate-y-1/2 flex items-center space-x-1.5 z-10">
                      <div className="text-[10px] font-bold text-slate-500">WEST</div>
                      <div className="w-16 h-7 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-around px-1 shadow-md">
                        {/* Green Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'West' && !isYellowPhase
                            ? 'bg-emerald-500 glow-green-active'
                            : 'bg-emerald-950 border border-emerald-900/20'
                        }`} />
                        {/* Yellow Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'West' && isYellowPhase
                            ? 'bg-yellow-500 glow-yellow-active'
                            : 'bg-yellow-950 border border-yellow-900/20'
                        }`} />
                        {/* Red Node */}
                        <div className={`w-4.5 h-4.5 rounded-full transition-all duration-300 ${
                          activeRoad === 'West'
                            ? 'bg-red-950 border border-red-900/20'
                            : 'bg-red-500 glow-red-active'
                        }`} />
                      </div>
                    </div>

                    {/* CENTER HUD DISPLAY */}
                    <div className="absolute flex flex-col items-center justify-center text-center p-2 rounded-full w-[84px] h-[84px] bg-slate-900 border border-slate-800 shadow-xl z-20">
                      {isSimulating ? (
                        <>
                          <div className="text-[9px] font-semibold text-slate-400 uppercase tracking-widest font-mono">TIMER</div>
                          <div className="text-xl font-bold font-mono text-white leading-none mt-1 animate-pulse">
                            {timerRemaining}
                          </div>
                          <div className="text-[8px] font-mono text-emerald-400 mt-1 font-bold">{activeRoad?.toUpperCase()}</div>
                        </>
                      ) : simulationFinished ? (
                        <>
                          <CheckCircle className="h-5 w-5 text-emerald-500" />
                          <span className="text-[8px] font-mono text-emerald-400 mt-1 font-bold">ALL CLEAR</span>
                        </>
                      ) : (
                        <>
                          <div className="text-[9px] font-semibold text-slate-500 tracking-wider font-mono">READY</div>
                          <div className="text-sm font-bold font-mono text-slate-400 mt-1">IDLE</div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Traffic Signal Status Panel */}
              <div className="glass-panel rounded-2xl p-5 space-y-4">
                <h3 className="text-base font-bold text-white border-b border-slate-800/60 pb-3 flex items-center space-x-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]"></span>
                  <span>Traffic Signal Live Status Grid</span>
                </h3>

                <div className="overflow-x-auto w-full">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-850 text-slate-400 uppercase tracking-wider font-mono">
                        <th className="py-2.5 font-semibold">Direction</th>
                        <th className="py-2.5 font-semibold">Signal State</th>
                        <th className="py-2.5 font-semibold">Vehicle Count</th>
                        <th className="py-2.5 font-semibold">Status Detail</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-850/60">
                      {ROADS.map(road => {
                        const roadData = vehicleCounts[road];
                        const count = roadData ? (typeof roadData === 'object' ? roadData.count : roadData) : 0;
                        const isGreen = activeRoad === road;
                        const isServed = servedRoads.includes(road) && activeRoad !== road;
                        
                        let signalText = 'RED';
                        let signalColor = 'text-rose-500 bg-rose-500/10 border-rose-500/20';
                        let statusText = 'Waiting...';

                        if (isGreen && isYellowPhase) {
                          signalText = 'YELLOW';
                          signalColor = 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20 font-bold';
                          statusText = `Yielding (${timerRemaining}s remaining)`;
                        } else if (isGreen) {
                          signalText = 'GREEN';
                          signalColor = 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20 font-bold';
                          statusText = `Discharging (${timerRemaining}s remaining)`;
                        } else if (isServed) {
                          signalText = 'RED';
                          signalColor = 'text-slate-500 bg-slate-800/10 border-slate-800/20';
                          statusText = 'Served';
                        }

                        return (
                          <tr 
                            key={road} 
                            className={`transition-colors duration-200 ${
                              isGreen ? 'bg-blue-950/10' : 'hover:bg-slate-900/10'
                            }`}
                          >
                            <td className="py-3 font-semibold text-slate-200">{ROAD_LABELS[road]}</td>
                            <td className="py-3">
                              <span className={`px-2.5 py-0.5 rounded-full border text-[10px] font-mono tracking-widest ${signalColor}`}>
                                {signalText}
                              </span>
                            </td>
                            <td className="py-3 font-mono text-slate-300 font-semibold">{count}</td>
                            <td className="py-3 text-slate-400 font-mono text-[11px]">{statusText}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>

          </div>
        )}

      </main>

      {/* Footer credits */}
      <footer className="max-w-7xl mx-auto mt-16 text-center text-xs text-slate-600 border-t border-slate-900 pt-6">
        <p>AI Smart Traffic Control Management Dashboard Terminal. Designed for College Mini-Project Demonstration.</p>
        <p className="mt-1 font-mono text-[10px] text-slate-700">YOLOv8 Model Inference API Gateway Protocol version 1.0.0 (Local)</p>
      </footer>
    </div>
  );
}
