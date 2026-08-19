import os
import logging
import threading
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ai.detect")

# Robust imports so a missing optional dependency produces a clear error at
# call time (via AIProcessingError) instead of an ImportError crash at
# process startup.
CV2_AVAILABLE = False
YOLO_AVAILABLE = False

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    logger.warning("OpenCV (cv2) is not available.")

try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    logger.warning("ultralytics (YOLO) is not available.")


class AIProcessingError(Exception):
    """Raised whenever a video/frame cannot be processed with real YOLO
    detection (missing dependency, missing file, unreadable video, missing
    model, or a detection/tracking failure).

    There is deliberately no mock/random fallback anywhere in this module --
    callers (app.py) must surface this as an explicit error to the caller
    rather than inventing a plausible-looking vehicle count.
    """
    pass


# ================================================================
# CONFIGURATION
# All of these can be overridden with environment variables without
# touching code, e.g. `YOLO_CONF_THRESHOLD=0.35 python app.py`.
# ================================================================

# Pretrained fallback model (COCO classes: car/motorcycle/bus/truck, no
# ambulance). Used until a custom model is trained via train.py.
BASE_MODEL_PATH = os.getenv("BASE_MODEL_PATH", "yolov8n.pt")

# Where train.py writes its best checkpoint. If this file exists it is
# preferred over BASE_MODEL_PATH, since only a custom-trained model can
# recognize the 'ambulance' class. Point this elsewhere via env var if you
# train on another machine and copy the weights over.
AMBULANCE_MODEL_PATH = os.getenv("AMBULANCE_MODEL_PATH", "runs/detect/train/weights/best.pt")

CONF_THRESHOLD = float(os.getenv("YOLO_CONF_THRESHOLD", "0.25"))
IOU_THRESHOLD = float(os.getenv("YOLO_IOU_THRESHOLD", "0.45"))

# Dropping inference resolution from YOLO's default (640) is the biggest
# CPU speed lever; 320 is still enough to count vehicles reliably at
# typical traffic-cam distances. Raise this (e.g. 640) if small/far vehicles
# are being missed and you can tolerate slower processing.
INFERENCE_IMGSZ = int(os.getenv("YOLO_IMGSZ", "320"))

# We only ever care about a handful of vehicle boxes per frame, so capping
# max_det keeps NMS cheap instead of the YOLO default of 300.
INFERENCE_MAX_DET = int(os.getenv("YOLO_MAX_DET", "50"))

# ByteTrack ships with ultralytics (ultralytics/cfg/trackers/bytetrack.yaml).
TRACKER_CONFIG = os.getenv("YOLO_TRACKER", "bytetrack.yaml")

# Process every Nth frame (1 = every frame). Frames in between are grabbed
# but not decoded/run through the model, which is cheap. Raising this trades
# tracking/counting accuracy for speed.
FRAME_SKIP = max(1, int(os.getenv("YOLO_FRAME_SKIP", "5")))

# Safety cap so one broken/very long video can't hang a single /analyze
# request forever. Set YOLO_MAX_FRAMES=0 to disable.
MAX_FRAMES_TO_PROCESS = int(os.getenv("YOLO_MAX_FRAMES", "600"))

# Virtual counting line: fraction (0-1) across the frame. A tracked vehicle
# is counted once, the first time it's observed on the far side of this
# line, which is what prevents counting the same vehicle every frame it's
# visible in.
COUNT_LINE_POSITION = float(os.getenv("YOLO_COUNT_LINE_POSITION", "0.6"))
COUNT_LINE_ORIENTATION = os.getenv("YOLO_COUNT_LINE_ORIENTATION", "horizontal")  # 'horizontal' or 'vertical'

# Ambulance-specific thresholds, kept separate from the general vehicle
# CONF_THRESHOLD so emergency preemption can require stronger evidence than
# plain vehicle counting does. AMBULANCE_CONFIRMATION_FRAMES requires the
# SAME tracked id to be seen as an ambulance (at >= AMBULANCE_MIN_CONFIDENCE)
# across this many processed frames before emergency=True is raised, which
# suppresses one-frame false positives from a single lucky detection.
AMBULANCE_MIN_CONFIDENCE = float(os.getenv("AMBULANCE_MIN_CONFIDENCE", "0.60"))
AMBULANCE_CONFIRMATION_FRAMES = int(os.getenv("AMBULANCE_CONFIRMATION_FRAMES", "3"))

# Green-light duration formula: seconds = BASE + PER_VEHICLE * count, clamped
# to [MIN, MAX]. Tune these instead of hardcoding durations.
GREEN_BASE_SECONDS = float(os.getenv("GREEN_BASE_SECONDS", "10"))
GREEN_SECONDS_PER_VEHICLE = float(os.getenv("GREEN_SECONDS_PER_VEHICLE", "0.6"))
GREEN_MIN_SECONDS = int(os.getenv("GREEN_MIN_SECONDS", "15"))
GREEN_MAX_SECONDS = int(os.getenv("GREEN_MAX_SECONDS", "60"))

# Category keywords we look for BY NAME in whatever model gets loaded, so
# this works whether class ids come from the COCO base model (car=2,
# motorcycle=3, bus=5, truck=7) or a custom dataset.yaml with a totally
# different ordering (e.g. the 0-4 scheme car/motorcycle/bus/truck/ambulance).
VEHICLE_CATEGORY_ALIASES = {
    "car": {"car"},
    "motorcycle": {"motorcycle", "motorbike"},
    "bus": {"bus"},
    "truck": {"truck"},
    "ambulance": {"ambulance"},
}

# Global caches so the model is loaded/warmed up once per process, not once
# per request.
yolo_model_cache = None
model_class_info_cache = None  # {'vehicle_ids', 'ambulance_id', 'names'}

# The cached YOLO model carries a single mutable predictor/tracker (see
# _reset_tracker below). If two requests run analyze_video/analyze_cv2_frame
# concurrently (e.g. a threaded WSGI server), one request's tracker reset can
# delete predictor.trackers while another request's in-flight model.track()
# call is mid-frame, raising "'DetectionPredictor' object has no attribute
# 'trackers'" and silently degrading that video to undercounting fallback
# mode. This lock serializes all model access so that failure mode can't
# happen regardless of how the WSGI server is configured.
_model_lock = threading.Lock()


def _resolve_class_ids(model_names):
    """Map a loaded model's {id: name} dict onto our known categories by
    name rather than assuming fixed ids, so both the COCO base model and any
    custom-trained model work regardless of class-id ordering."""
    lower_names = {cid: str(name).strip().lower() for cid, name in model_names.items()}
    resolved = {}
    for category, aliases in VEHICLE_CATEGORY_ALIASES.items():
        match = next((cid for cid, name in lower_names.items() if name in aliases), None)
        resolved[category] = match

    vehicle_ids = [cid for cat, cid in resolved.items() if cat != "ambulance" and cid is not None]
    ambulance_id = resolved.get("ambulance")
    return vehicle_ids, ambulance_id


def get_yolo_model():
    """Loads (and caches) the YOLO model used for detection/tracking.

    Prefers a custom-trained model at AMBULANCE_MODEL_PATH (produced by
    train.py) when one exists, since only a custom-trained model can
    recognize 'ambulance'. Falls back to the pretrained COCO model
    (BASE_MODEL_PATH), which still detects car/motorcycle/bus/truck but can
    never set emergency=True.

    Raises AIProcessingError if ultralytics isn't installed or the model
    fails to load -- never returns a placeholder/mock model.
    """
    global yolo_model_cache, model_class_info_cache
    if not YOLO_AVAILABLE:
        raise AIProcessingError("ultralytics is not installed in this environment.")

    if yolo_model_cache is not None:
        return yolo_model_cache, model_class_info_cache

    if os.path.exists(AMBULANCE_MODEL_PATH):
        model_path = AMBULANCE_MODEL_PATH
        logger.info(f"Loading custom-trained model with ambulance support: {model_path}")
    else:
        model_path = BASE_MODEL_PATH
        logger.warning(
            f"No custom-trained model found at '{AMBULANCE_MODEL_PATH}'. Falling back to "
            f"'{model_path}' (COCO classes only) -- ambulance detection will stay unavailable "
            f"(emergency will always be False) until you train one with train.py. "
            f"See dataset/data.yaml for the expected dataset layout."
        )

    try:
        model = YOLO(model_path)
    except Exception as e:
        raise AIProcessingError(f"Failed to load YOLO model '{model_path}': {e}") from e

    vehicle_ids, ambulance_id = _resolve_class_ids(model.names)
    if not vehicle_ids:
        raise AIProcessingError(
            f"Loaded model '{model_path}' has no recognizable vehicle classes: {model.names}"
        )

    # Warm up: the first inference call allocates buffers and traces the
    # graph, which otherwise makes the first real request slow.
    import numpy as np
    dummy_frame = np.zeros((INFERENCE_IMGSZ, INFERENCE_IMGSZ, 3), dtype=np.uint8)
    model(dummy_frame, imgsz=INFERENCE_IMGSZ, verbose=False)

    yolo_model_cache = model
    model_class_info_cache = {
        "vehicle_ids": vehicle_ids,
        "ambulance_id": ambulance_id,
        "names": model.names,
        "has_ambulance": ambulance_id is not None,
    }
    logger.info(
        f"Model loaded from '{model_path}'. Vehicle class ids: {vehicle_ids}. "
        f"Ambulance class id: {ambulance_id} (available: {ambulance_id is not None})."
    )
    return yolo_model_cache, model_class_info_cache


def _reset_tracker(model):
    """Force a fresh (empty) ByteTrack state before starting a new video.

    The YOLO model instance (and its predictor/tracker) is cached and reused
    across requests for performance. Without this, track IDs and lost-track
    history from a previous road's video would leak into the next road's
    frames, since ultralytics only reinitializes trackers when the
    predictor doesn't already have one attached.
    """
    predictor = getattr(model, "predictor", None)
    if predictor is not None and hasattr(predictor, "trackers"):
        del predictor.trackers


def _box_center(box):
    x1, y1, x2, y2 = box.xyxy[0].tolist()
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0


def _line_position_px(frame_width, frame_height):
    if COUNT_LINE_ORIENTATION == "vertical":
        return int(frame_width * COUNT_LINE_POSITION)
    return int(frame_height * COUNT_LINE_POSITION)


def analyze_video(video_path, road_name="Road"):
    """
    Runs YOLO detection + ByteTrack tracking over a traffic video to count
    UNIQUE vehicles (not per-frame detections) and flag emergency=True once a
    tracked ambulance is CONFIRMED (seen for AMBULANCE_CONFIRMATION_FRAMES
    consecutive processed frames at >= AMBULANCE_MIN_CONFIDENCE).

    A vehicle is counted once -- the first time its tracked center is
    observed on the far side of the configured virtual line
    (COUNT_LINE_POSITION) -- which is what prevents the same vehicle from
    being counted in every frame it appears in.

    Raises AIProcessingError on any failure (missing dependency, missing
    file, unreadable video, missing model, tracking error, zero readable
    frames). There is no mock/random fallback -- callers must surface the
    error, not substitute a fake count.
    """
    analysis_start = time.perf_counter()
    logger.info(f"[{road_name}] Starting analysis: {video_path}")

    if not CV2_AVAILABLE:
        raise AIProcessingError("OpenCV (cv2) is not installed in this environment.")

    if not video_path or not os.path.exists(video_path):
        raise AIProcessingError(f"Video file not found: {video_path}")

    model, class_info = get_yolo_model()

    vehicle_ids = class_info["vehicle_ids"]
    ambulance_id = class_info["ambulance_id"]
    detect_classes = vehicle_ids + ([ambulance_id] if ambulance_id is not None else [])

    cap = None
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise AIProcessingError(f"OpenCV could not open video file: {video_path}")

        counted_ids = set()              # unique vehicle track ids counted so far
        ambulance_streak = {}            # track_id -> consecutive confirmed-conf frame count
        confirmed_ambulance_ids = set()  # track ids that reached AMBULANCE_CONFIRMATION_FRAMES
        track_past_line = {}             # track_id -> bool, last known side of the line
        tracking_supported = True        # flips to False if the tracker backend fails
        fallback_frame_max = 0           # best-effort floor for vehicle_count if tracking degrades

        frame_index = 0
        processed_frames = 0

        # Holds _model_lock for the whole video, not just each model call: the
        # tracker reset (_reset_tracker) and every model.track() call below
        # share the SAME cached model/predictor, so another thread's reset
        # landing mid-video would corrupt this loop's tracker state exactly
        # like the concurrent-request bug this lock exists to prevent.
        with _model_lock:
            _reset_tracker(model)

            frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
            frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
            line_px = _line_position_px(frame_width, frame_height)

            while True:
                if MAX_FRAMES_TO_PROCESS and processed_frames >= MAX_FRAMES_TO_PROCESS:
                    logger.info(f"[{road_name}] Reached YOLO_MAX_FRAMES ({MAX_FRAMES_TO_PROCESS}); stopping early.")
                    break

                if frame_index % FRAME_SKIP != 0:
                    if not cap.grab():
                        break
                    frame_index += 1
                    continue

                ret, frame = cap.read()
                if not ret:
                    break
                frame_index += 1
                processed_frames += 1

                if processed_frames == 1 or processed_frames % 50 == 0:
                    elapsed = time.perf_counter() - analysis_start
                    logger.info(
                        f"[{road_name}] Progress: {processed_frames} frames processed, "
                        f"elapsed={elapsed:.2f}s"
                    )

                infer_kwargs = dict(
                    conf=CONF_THRESHOLD,
                    iou=IOU_THRESHOLD,
                    classes=detect_classes,
                    imgsz=INFERENCE_IMGSZ,
                    max_det=INFERENCE_MAX_DET,
                    verbose=False,
                )

                if tracking_supported:
                    try:
                        results = model.track(frame, tracker=TRACKER_CONFIG, persist=True, **infer_kwargs)
                    except Exception as e:
                        logger.error(
                            f"[{road_name}] Tracking backend failed ({e}); falling back to per-frame "
                            f"detection for the rest of this video (unique-vehicle counting will degrade)."
                        )
                        tracking_supported = False
                        results = model(frame, **infer_kwargs)
                else:
                    results = model(frame, **infer_kwargs)

                for r in results:
                    boxes = r.boxes
                    if boxes is None or len(boxes) == 0:
                        continue

                    has_ids = tracking_supported and boxes.id is not None
                    ids_iter = boxes.id.tolist() if has_ids else [None] * len(boxes)

                    if not has_ids:
                        # Tracking is disabled/failed for this frame, so there's
                        # no persistent id to dedupe against across frames.
                        # Rather than silently counting zero vehicles for the
                        # rest of the video (the old behavior), track the most
                        # vehicles simultaneously visible in any one fallback
                        # frame as a floor estimate -- an undercount vs. true
                        # tracking, but far closer than a hard zero.
                        frame_vehicle_count = sum(
                            1 for box in boxes if int(box.cls[0]) != ambulance_id
                        )
                        fallback_frame_max = max(fallback_frame_max, frame_vehicle_count)

                    for box, raw_tid in zip(boxes, ids_iter):
                        cls_id = int(box.cls[0])
                        conf = float(box.conf[0])

                        if raw_tid is None:
                            # No tracker id available (tracking disabled/failed) --
                            # can't require multi-frame confirmation without a
                            # persistent id, so fall back to a single-frame,
                            # high-confidence check for this box only.
                            if cls_id == ambulance_id and conf >= AMBULANCE_MIN_CONFIDENCE:
                                confirmed_ambulance_ids.add(f"untracked-{frame_index}-{len(confirmed_ambulance_ids)}")
                                logger.info(
                                    f"[{road_name}] AMBULANCE detected (untracked, frame {frame_index}, conf={conf:.2f})."
                                )
                            continue

                        tid = int(raw_tid)
                        cx, cy = _box_center(box)
                        past_line = (cy > line_px) if COUNT_LINE_ORIENTATION != "vertical" else (cx > line_px)
                        previously_past = track_past_line.get(tid)
                        track_past_line[tid] = past_line

                        if cls_id == ambulance_id:
                            if conf >= AMBULANCE_MIN_CONFIDENCE:
                                ambulance_streak[tid] = ambulance_streak.get(tid, 0) + 1
                            else:
                                ambulance_streak[tid] = 0

                            if (
                                ambulance_streak[tid] >= AMBULANCE_CONFIRMATION_FRAMES
                                and tid not in confirmed_ambulance_ids
                            ):
                                confirmed_ambulance_ids.add(tid)
                                logger.info(
                                    f"[{road_name}] AMBULANCE CONFIRMED (track_id={tid}, conf={conf:.2f}, "
                                    f"seen {ambulance_streak[tid]} consecutive frames >= "
                                    f"{AMBULANCE_MIN_CONFIDENCE:.2f} confidence)."
                                )

                        if tid in counted_ids:
                            continue

                        if past_line and (previously_past is None or previously_past is False):
                            counted_ids.add(tid)
                            logger.info(
                                f"[{road_name}] Counted unique vehicle track_id={tid} "
                                f"(total so far={len(counted_ids)})."
                            )

        if processed_frames == 0:
            raise AIProcessingError(f"No frames could be read from video: {video_path}")

        vehicle_count = max(len(counted_ids), fallback_frame_max)
        emergency_detected = len(confirmed_ambulance_ids) > 0

        elapsed = time.perf_counter() - analysis_start
        logger.info(
            f"[{road_name}] Analysis complete. frames_processed={processed_frames}, "
            f"unique_vehicles={vehicle_count}, confirmed_ambulances={len(confirmed_ambulance_ids)}, "
            f"emergency={emergency_detected}, tracking_supported={tracking_supported}, "
            f"elapsed={elapsed:.2f}s."
        )

        return {
            "count": vehicle_count,
            "emergency": emergency_detected,
        }

    except AIProcessingError:
        raise
    except Exception as e:
        raise AIProcessingError(f"Video processing failed for '{video_path}': {e}") from e
    finally:
        if cap is not None:
            cap.release()


def calculate_green_duration(vehicle_count):
    """
    Dynamically calculates the green signal duration based on the number of
    vehicles detected. seconds = GREEN_BASE_SECONDS + GREEN_SECONDS_PER_VEHICLE
    * count, clamped to [GREEN_MIN_SECONDS, GREEN_MAX_SECONDS]. All three are
    configurable via environment variables (see CONFIGURATION above).
    """
    duration = GREEN_BASE_SECONDS + (vehicle_count * GREEN_SECONDS_PER_VEHICLE)
    return int(max(GREEN_MIN_SECONDS, min(GREEN_MAX_SECONDS, duration)))


def analyze_cv2_frame(frame, road_name="Webcam"):
    """
    Analyzes a single in-memory OpenCV frame (numpy array) from the live
    webcam endpoint. Each call is an independent HTTP request with no
    guaranteed continuity from the previous one, so this reports vehicles
    currently visible in this frame rather than a deduplicated running count
    (true cross-request tracking would need a persistent per-road session,
    which the current webcam endpoint doesn't have). Ambulance detection
    here is a single-frame, high-confidence check (AMBULANCE_MIN_CONFIDENCE)
    -- true multi-frame confirmation (AMBULANCE_CONFIRMATION_FRAMES) only
    applies to analyze_video, where a persistent track id exists.

    Raises AIProcessingError on any failure. No mock/random fallback.
    """
    logger.info(f"[{road_name}] Starting webcam frame analysis...")

    if not CV2_AVAILABLE:
        raise AIProcessingError("OpenCV (cv2) is not installed in this environment.")
    if frame is None:
        raise AIProcessingError("Received an empty/undecodable frame.")

    model, class_info = get_yolo_model()

    vehicle_ids = class_info["vehicle_ids"]
    ambulance_id = class_info["ambulance_id"]
    detect_classes = vehicle_ids + ([ambulance_id] if ambulance_id is not None else [])

    try:
        with _model_lock:
            results = model(
                frame,
                conf=CONF_THRESHOLD,
                iou=IOU_THRESHOLD,
                classes=detect_classes,
                imgsz=INFERENCE_IMGSZ,
                max_det=INFERENCE_MAX_DET,
                verbose=False,
            )

        vehicle_count = 0
        emergency_detected = False

        for r in results:
            boxes = r.boxes
            if boxes is None:
                continue
            for box in boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                if cls_id == ambulance_id and conf >= AMBULANCE_MIN_CONFIDENCE:
                    emergency_detected = True
                vehicle_count += 1

        logger.info(
            f"[{road_name}] Frame analysis complete. count={vehicle_count}, emergency={emergency_detected}"
        )
        return {
            "count": vehicle_count,
            "emergency": emergency_detected
        }
    except AIProcessingError:
        raise
    except Exception as e:
        raise AIProcessingError(f"Frame processing failed: {e}") from e