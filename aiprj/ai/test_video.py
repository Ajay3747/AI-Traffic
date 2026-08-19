"""
Runs the SAME detection + tracking + counting logic as detect.py's
analyze_video() against a video file, but with live console output and an
optional annotated output video -- for visually/manually sanity-checking a
model before (or instead of) trusting the numeric metrics alone.

Usage:
    python test_video.py path/to/video.mp4 [--save]

Reuses detect.py's configuration (AMBULANCE_MODEL_PATH, CONF_THRESHOLD,
AMBULANCE_MIN_CONFIDENCE, COUNT_LINE_POSITION, etc.) directly, so whatever
you see here is what the Flask /analyze endpoint will actually do -- not a
separate, potentially-diverging implementation. Override any of them the
same way as detect.py, e.g.:

    YOLO_CONF_THRESHOLD=0.4 AMBULANCE_MIN_CONFIDENCE=0.7 python test_video.py video.mp4

Example output:
    CAR ID 21        conf=0.81
    CAR ID 24        conf=0.77
    TRUCK ID 30      conf=0.68
    AMBULANCE ID 34  conf=0.91  (confirmed emergency)

    Frames processed: 812
    Vehicle Count: 17
    Ambulance: YES
"""
import argparse
import os
import sys

import cv2

import detect as D  # reuse exact config + helpers, not a re-implementation


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("video", help="Path to a test video")
    parser.add_argument("--save", action="store_true", help="Save an annotated output video (boxes+id+conf)")
    parser.add_argument("--quiet", action="store_true", help="Only print the final summary, not per-detection lines")
    args = parser.parse_args()

    if not os.path.exists(args.video):
        print(f"Video not found: {args.video}")
        sys.exit(1)

    model, class_info = D.get_yolo_model()
    names = class_info["names"]
    vehicle_ids = class_info["vehicle_ids"]
    ambulance_id = class_info["ambulance_id"]
    detect_classes = vehicle_ids + ([ambulance_id] if ambulance_id is not None else [])

    print(f"Model classes: {names}")
    print(f"Vehicle class ids: {vehicle_ids}  Ambulance class id: {ambulance_id}")
    if ambulance_id is None:
        print("NOTE: this model has no 'ambulance' class -- emergency will never trigger. Train one with train.py.")
    print(
        f"conf>={D.CONF_THRESHOLD} iou={D.IOU_THRESHOLD} imgsz={D.INFERENCE_IMGSZ} "
        f"tracker={D.TRACKER_CONFIG} line={D.COUNT_LINE_POSITION} ({D.COUNT_LINE_ORIENTATION}) "
        f"ambulance_conf>={D.AMBULANCE_MIN_CONFIDENCE} confirm_frames={D.AMBULANCE_CONFIRMATION_FRAMES}\n"
    )

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"Could not open video: {args.video}")
        sys.exit(1)

    D._reset_tracker(model)
    frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
    frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    line_px = D._line_position_px(frame_width, frame_height)

    writer = None
    if args.save:
        out_path = os.path.splitext(args.video)[0] + "_annotated.mp4"
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(out_path, fourcc, fps, (frame_width, frame_height))
        print(f"Saving annotated video to: {out_path}")

    counted_ids = set()
    ambulance_streak = {}
    confirmed_ambulance_ids = set()
    track_past_line = {}
    reported_ids = set()  # ids we've already printed a "CAR ID x" line for

    frame_index = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_index += 1

        results = model.track(
            frame,
            conf=D.CONF_THRESHOLD,
            iou=D.IOU_THRESHOLD,
            classes=detect_classes,
            imgsz=D.INFERENCE_IMGSZ,
            max_det=D.INFERENCE_MAX_DET,
            tracker=D.TRACKER_CONFIG,
            persist=True,
            verbose=False,
        )

        for r in results:
            boxes = r.boxes
            if boxes is None or len(boxes) == 0 or boxes.id is None:
                continue

            for box, raw_tid in zip(boxes, boxes.id.tolist()):
                tid = int(raw_tid)
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                cls_name = names.get(cls_id, str(cls_id))

                cx, cy = D._box_center(box)
                past_line = (cy > line_px) if D.COUNT_LINE_ORIENTATION != "vertical" else (cx > line_px)
                previously_past = track_past_line.get(tid)
                track_past_line[tid] = past_line

                is_ambulance = cls_id == ambulance_id
                if is_ambulance:
                    if conf >= D.AMBULANCE_MIN_CONFIDENCE:
                        ambulance_streak[tid] = ambulance_streak.get(tid, 0) + 1
                    else:
                        ambulance_streak[tid] = 0
                    if ambulance_streak[tid] >= D.AMBULANCE_CONFIRMATION_FRAMES:
                        confirmed_ambulance_ids.add(tid)

                if tid not in reported_ids:
                    reported_ids.add(tid)
                    tag = "  (confirmed emergency)" if (is_ambulance and tid in confirmed_ambulance_ids) else ""
                    if not args.quiet:
                        print(f"{cls_name.upper()} ID {tid:<4d} conf={conf:.2f}{tag}")

                if tid not in counted_ids and past_line and (previously_past is None or previously_past is False):
                    counted_ids.add(tid)

                if writer is not None:
                    x1, y1, x2, y2 = (int(v) for v in box.xyxy[0].tolist())
                    color = (0, 0, 255) if is_ambulance else (0, 200, 0)
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    label = f"{cls_name} #{tid} {conf:.2f}"
                    cv2.putText(frame, label, (x1, max(0, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

        if writer is not None:
            cv2.line(
                frame,
                (0, line_px) if D.COUNT_LINE_ORIENTATION != "vertical" else (line_px, 0),
                (frame_width, line_px) if D.COUNT_LINE_ORIENTATION != "vertical" else (line_px, frame_height),
                (255, 255, 0),
                2,
            )
            writer.write(frame)

    cap.release()
    if writer is not None:
        writer.release()

    emergency = len(confirmed_ambulance_ids) > 0
    print(f"\nFrames processed: {frame_index}")
    print(f"Vehicle Count: {len(counted_ids)}")
    print(f"Ambulance: {'YES' if emergency else 'NO'}  (confirmed track ids: {sorted(confirmed_ambulance_ids)})")


if __name__ == "__main__":
    main()
