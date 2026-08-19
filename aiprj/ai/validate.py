"""
Evaluates a trained model's precision/recall/mAP on the validation split
defined in dataset/data.yaml, including a per-class breakdown so you can
check ambulance detection quality specifically.

Usage:
    python validate.py [path/to/best.pt]

If no path is given, uses WEIGHTS env var, falling back to the default
train.py output location.
"""
import os
import sys
from ultralytics import YOLO

DATASET = os.getenv("DATASET", "dataset/data.yaml")
DEFAULT_WEIGHTS = "runs/detect/train/weights/best.pt"


def main():
    weights = sys.argv[1] if len(sys.argv) > 1 else os.getenv("WEIGHTS", DEFAULT_WEIGHTS)
    if not os.path.exists(weights):
        raise FileNotFoundError(f"Weights not found: {weights}. Train a model first with train.py.")
    if not os.path.exists(DATASET):
        raise FileNotFoundError(f"Dataset config not found: {DATASET}.")

    print(f"Evaluating {weights} on {DATASET}")
    model = YOLO(weights)
    metrics = model.val(data=DATASET)

    print("\n=== Overall metrics ===")
    print(f"Precision (mean): {metrics.box.mp:.4f}")
    print(f"Recall (mean):    {metrics.box.mr:.4f}")
    print(f"mAP50:            {metrics.box.map50:.4f}")
    print(f"mAP50-95:         {metrics.box.map:.4f}")

    print("\n=== Per-class metrics ===")
    names = metrics.names
    for i, class_id in enumerate(metrics.ap_class_index):
        class_name = names[int(class_id)]
        print(
            f"{class_name:12s}  P={metrics.box.p[i]:.4f}  R={metrics.box.r[i]:.4f}  "
            f"mAP50={metrics.box.ap50[i]:.4f}  mAP50-95={metrics.box.ap[i]:.4f}"
        )

    ambulance_ap_idx = next(
        (i for i, cid in enumerate(metrics.ap_class_index) if names[int(cid)].lower() == "ambulance"),
        None,
    )
    ambulance_class_id = next((cid for cid, n in names.items() if str(n).lower() == "ambulance"), None)

    print("\n=== Ambulance detection performance ===")
    if ambulance_ap_idx is not None:
        print(
            f"Precision={metrics.box.p[ambulance_ap_idx]:.4f}  Recall={metrics.box.r[ambulance_ap_idx]:.4f}  "
            f"mAP50={metrics.box.ap50[ambulance_ap_idx]:.4f}  mAP50-95={metrics.box.ap[ambulance_ap_idx]:.4f}"
        )
    else:
        print("No 'ambulance' class found in this model/dataset's validation results "
              "(zero ambulance ground-truth boxes in the val split, or the model has no ambulance class).")

    # Confusion-matrix-derived TP/FP/FN counts answer the exact questions
    # the spec asks for: how many real ambulances were detected, missed,
    # and how many false ambulance alarms occurred.
    cm = getattr(metrics, "confusion_matrix", None)
    if cm is not None and ambulance_class_id is not None:
        matrix = cm.matrix  # matrix[predicted_class][ground_truth_class]; last index = background
        tp = int(matrix[ambulance_class_id, ambulance_class_id])
        fp = int(matrix[ambulance_class_id, :].sum() - tp)  # predicted ambulance, truth was something else
        fn = int(matrix[:, ambulance_class_id].sum() - tp)  # truth was ambulance, predicted something else
        print(
            f"\nReal ambulances detected (TP):     {tp}\n"
            f"Real ambulances missed (FN):       {fn}\n"
            f"False ambulance detections (FP):   {fp}"
        )
        if tp + fn > 0:
            print(f"-> Of {tp + fn} real ambulances in the val split, {tp} were caught ({tp / (tp + fn):.1%}).")

    print("\n=== Per-class confusion (most-confused-with) ===")
    if cm is not None:
        matrix = cm.matrix
        for cid in sorted(names.keys()):
            row_wo_self = matrix[cid].copy()
            row_wo_self[cid] = 0
            if row_wo_self.sum() == 0:
                continue
            confused_with_idx = int(row_wo_self.argmax())
            confused_with = "background" if confused_with_idx == len(names) else names.get(confused_with_idx, confused_with_idx)
            print(f"  {names[cid]:12s} most often predicted as truth={confused_with} ({int(row_wo_self[confused_with_idx])}x)")

    save_dir = getattr(metrics, "save_dir", None)
    if save_dir:
        print(f"\nSaved artifacts (confusion_matrix.png, PR_curve.png, F1_curve.png, P_curve.png, R_curve.png): {save_dir}")


if __name__ == "__main__":
    main()
