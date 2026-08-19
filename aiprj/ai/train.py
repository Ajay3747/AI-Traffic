"""
Fine-tunes YOLO model(s) on dataset/data.yaml (car/motorcycle/bus/truck/ambulance),
optimized for accuracy over training speed, per the project's requirements.

ALWAYS run validate_dataset.py first. Training on a dataset with missing
labels, invalid boxes, or train/val leakage will silently produce a model
whose reported accuracy cannot be trusted.

Usage:
    python train.py

Every value below can be overridden with an environment variable of the
same name without touching this file, e.g.:

    EPOCHS=80 BATCH=8 MODEL_CANDIDATES=yolo11s.pt python train.py

==========================================================================
HARDWARE REALITY CHECK (read before changing MODEL_CANDIDATES)
==========================================================================
This machine has NO CUDA GPU (torch reports cuda.is_available()=False) --
everything trains on CPU, with 12 logical cores / ~12.6GB RAM at the time
this was set up. On CPU:
  - yolo11n / yolo11s are realistic to train in a reasonable amount of time.
  - yolo11m has roughly 2x the FLOPs of yolo11s. On CPU that translates
    roughly linearly to slower epochs, not "slightly slower" -- expect on
    the order of 2-4x longer per epoch, and total wall-clock time in the
    hours-to-a-day range for 50-100 epochs on a modest dataset.
  - yolo11l/x are not realistic on this hardware for the epoch counts
    accuracy needs; skip them unless you move to a CUDA machine.

MODEL_CANDIDATES below trains every listed model back-to-back and prints a
side-by-side comparison (mAP50, mAP50-95, ambulance recall) at the end, so
you can make the small-vs-medium call from real validation numbers instead
of a guess. Default is just yolo11s.pt to keep a first run practical; add
",yolo11m.pt" once you've confirmed the pipeline works end-to-end and are
prepared to wait.
==========================================================================
"""
import os
import csv
from ultralytics import YOLO

# ---- CONFIG (override via environment variables of the same name) ----
MODEL_CANDIDATES = [m.strip() for m in os.getenv("MODEL_CANDIDATES", "yolo11s.pt").split(",") if m.strip()]
DATASET = os.getenv("DATASET", "dataset/data.yaml")
EPOCHS = int(os.getenv("EPOCHS", "100"))
IMAGE_SIZE = int(os.getenv("IMAGE_SIZE", "640"))
BATCH = os.getenv("BATCH", "-1")  # -1 = ultralytics auto-selects the largest batch that fits in memory
BATCH = int(BATCH) if BATCH not in ("-1", "auto") else -1
DEVICE = os.getenv("DEVICE", "cpu")  # 'cpu', or '0' / '0,1' for GPU(s)
PATIENCE = int(os.getenv("PATIENCE", "20"))  # early-stop after N epochs with no val improvement
PROJECT = os.getenv("PROJECT", "runs/detect")

# Reproducibility: fixed seed + deterministic algorithms, so re-running with
# the same data/config gives comparable results when you're deciding
# between dataset/config changes (accuracy_improvement_loop.md workflow).
SEED = int(os.getenv("SEED", "0"))
DETERMINISTIC = os.getenv("DETERMINISTIC", "true").lower() == "true"

# ==========================================================================
# AUGMENTATION -- chosen specifically for traffic-camera footage, not
# ultralytics' generic defaults. Rationale per setting:
# ==========================================================================
AUGMENTATION = dict(
    # Lighting/color: traffic cams see day/night/shadows/reflections, so
    # moderate HSV jitter is directly useful (this is the "different
    # lighting conditions" and "night scenes" requirement).
    hsv_h=0.015,   # slight hue jitter -- keep small, vehicle color matters (ambulance red-cross etc.)
    hsv_s=0.5,     # saturation jitter -- useful for washed-out/overcast footage
    hsv_v=0.35,    # brightness/value jitter -- useful for day/night variation

    # Geometry: "slight rotation/scaling/translation" as requested -- kept
    # modest because traffic-cam mounting angles don't vary wildly, and
    # large rotation would distort vehicle aspect ratios unrealistically.
    degrees=5.0,
    translate=0.1,
    scale=0.4,       # covers both near (large) and far (small) vehicles
    shear=0.0,       # not realistic for a fixed traffic camera -- disabled

    # Flips: LEFT-RIGHT flip is realistic (a road mirrored left-to-right is
    # still a plausible road) so it's enabled. UP-DOWN flip is explicitly
    # disabled -- an upside-down vehicle never occurs in real footage and
    # would only teach the model garbage, actively hurting ambulance
    # detection (a flipped ambulance cross/lightbar looks like noise).
    fliplr=0.5,
    flipud=0.0,

    # Mosaic/mixup: mosaic (tiling 4 images together) is good for crowded-
    # traffic robustness and small/far vehicles, since it forces the model
    # to detect objects at varied scales and next to unrelated clutter --
    # kept on. Mixup (alpha-blending two whole images) is disabled: for a
    # class like 'ambulance' that the model needs to learn from relatively
    # few examples, blending it into a half-transparent ghost of another
    # vehicle is more likely to teach a confused decision boundary than to
    # help, per the "don't blindly enable every augmentation" requirement.
    mosaic=1.0,
    mixup=0.0,
    close_mosaic=10,  # disable mosaic for the last 10 epochs so the model
                       # fine-tunes on realistic, non-tiled images

    # Blur / noise / compression artifacts: only actually applied if
    # `albumentations` is installed (see requirements.txt) -- ultralytics
    # wires in Blur/MedianBlur/CLAHE/RandomGamma/JPEG-compression
    # automatically at low probability when it's available. This directly
    # covers the "blur, noise, weather/lighting variations" requirement
    # without needing custom augmentation code.
)


def resolve_dataset_path():
    dataset_path = os.path.abspath(DATASET)
    if not os.path.exists(dataset_path):
        raise FileNotFoundError(
            f"Dataset config not found at {dataset_path}. Populate "
            f"dataset/images/{{train,val}} and dataset/labels/{{train,val}} first, "
            f"then run validate_dataset.py -- see dataset/data.yaml for the expected layout."
        )
    return dataset_path


def train_one(model_name, dataset_path, run_name):
    print(f"\n{'=' * 70}\nTraining {model_name}  ->  run name: {run_name}\n{'=' * 70}")
    print(f"epochs={EPOCHS} imgsz={IMAGE_SIZE} batch={BATCH} device={DEVICE} seed={SEED}")

    model = YOLO(model_name)
    model.train(
        data=dataset_path,
        epochs=EPOCHS,
        imgsz=IMAGE_SIZE,
        batch=BATCH,
        device=DEVICE,
        patience=PATIENCE,
        project=PROJECT,
        name=run_name,
        seed=SEED,
        deterministic=DETERMINISTIC,
        # ultralytics always tracks the best-fitness (weighted mAP) epoch on
        # the VALIDATION set and saves it as weights/best.pt -- this is not
        # "lowest training loss", it's already validation-driven by default.
        **AUGMENTATION,
    )

    best_weights = os.path.join(PROJECT, run_name, "weights", "best.pt")

    # Validate the best checkpoint (not the final epoch) so the comparison
    # table reflects the model that will actually be deployed.
    val_model = YOLO(best_weights)
    metrics = val_model.val(data=dataset_path)

    names = metrics.names
    ambulance_idx = next(
        (i for i, cid in enumerate(metrics.ap_class_index) if names[int(cid)].lower() == "ambulance"),
        None,
    )
    ambulance_recall = metrics.box.r[ambulance_idx] if ambulance_idx is not None else None
    ambulance_map50 = metrics.box.ap50[ambulance_idx] if ambulance_idx is not None else None

    return {
        "model": model_name,
        "run_name": run_name,
        "best_weights": best_weights,
        "map50": float(metrics.box.map50),
        "map50_95": float(metrics.box.map),
        "precision": float(metrics.box.mp),
        "recall": float(metrics.box.mr),
        "ambulance_recall": float(ambulance_recall) if ambulance_recall is not None else None,
        "ambulance_map50": float(ambulance_map50) if ambulance_map50 is not None else None,
    }


def main():
    dataset_path = resolve_dataset_path()
    results = []

    for model_name in MODEL_CANDIDATES:
        run_name = os.path.splitext(model_name)[0].replace("/", "_")
        results.append(train_one(model_name, dataset_path, run_name))

    print(f"\n{'=' * 70}\nCOMPARISON (best checkpoint of each model, evaluated on the val split)\n{'=' * 70}")
    header = f"{'model':16s} {'mAP50':>8s} {'mAP50-95':>10s} {'precision':>10s} {'recall':>8s} {'amb.recall':>11s}"
    print(header)
    for r in results:
        amb_r = f"{r['ambulance_recall']:.4f}" if r["ambulance_recall"] is not None else "n/a"
        print(
            f"{r['model']:16s} {r['map50']:8.4f} {r['map50_95']:10.4f} "
            f"{r['precision']:10.4f} {r['recall']:8.4f} {amb_r:>11s}"
        )

    best = max(results, key=lambda r: r["map50_95"])
    print(f"\nBest by mAP50-95: {best['model']} -> {best['best_weights']}")
    print(
        "Point AMBULANCE_MODEL_PATH (see detect.py) at that weights file to activate it "
        "in the Flask service -- it's auto-detected if left at runs/detect/train/weights/best.pt."
    )

    # Persist the comparison so it survives beyond the console (used by the
    # accuracy-improvement loop to compare across training rounds).
    comparison_path = os.path.join(PROJECT, "training_comparison.csv")
    write_header = not os.path.exists(comparison_path)
    with open(comparison_path, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(results[0].keys()))
        if write_header:
            writer.writeheader()
        writer.writerows(results)
    print(f"Comparison appended to {comparison_path}")


if __name__ == "__main__":
    main()
