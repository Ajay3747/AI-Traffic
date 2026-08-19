"""
Validates the dataset defined in dataset/data.yaml BEFORE training.

Run this first, every time the dataset changes:
    python validate_dataset.py [path/to/data.yaml]

Checks, per split (train/val/test) and in aggregate:
  - image <-> label pairing (missing labels, orphaned labels)
  - corrupted / unreadable images
  - duplicate images (exact byte-for-byte; also flags cross-split duplicates,
    which are a data-leakage red flag -- the same frame must not appear in
    both train and val/test)
  - invalid YOLO label lines (bad class id, out-of-range/negative
    coordinates, zero-or-negative width/height, box extending outside the
    image)
  - empty label files
  - extremely small bounding boxes (likely annotation noise)
  - images-per-class / objects-per-class distribution, with an explicit
    class-imbalance warning (ambulance is called out specifically, since a
    starved ambulance class directly hurts emergency-detection accuracy)

This script does not modify any files -- it only reports.
"""
import sys
import os
import hashlib
import glob
from collections import defaultdict

try:
    import yaml
except ImportError:
    print("PyYAML is required: pip install pyyaml")
    sys.exit(1)

try:
    import cv2
except ImportError:
    cv2 = None
    print("WARNING: opencv not installed -- corrupted-image checks will be skipped.")

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

# A box smaller than this fraction of the frame area is flagged as
# suspiciously small (likely a mislabeled speck rather than a real vehicle).
# Tune per your camera distance/resolution.
TINY_BOX_AREA_FRACTION = float(os.getenv("VALIDATE_TINY_BOX_AREA_FRACTION", "0.0005"))

# Tolerance for "box extends outside the image" checks, to avoid flagging
# harmless floating-point rounding from annotation tools.
BOUNDS_EPSILON = 1e-4


def load_data_yaml(path):
    with open(path, "r") as f:
        cfg = yaml.safe_load(f)
    if not cfg or "names" not in cfg:
        raise ValueError(f"'{path}' has no 'names' key -- not a valid YOLO data.yaml")
    names = cfg["names"]
    if isinstance(names, list):
        names = {i: n for i, n in enumerate(names)}
    else:
        names = {int(k): v for k, v in names.items()}
    base_dir = os.path.dirname(os.path.abspath(path))
    dataset_root = os.path.join(base_dir, cfg.get("path", "."))
    splits = {}
    for split in ("train", "val", "test"):
        if split in cfg:
            splits[split] = os.path.normpath(os.path.join(dataset_root, cfg[split]))
    return names, splits, dataset_root


def images_dir_to_labels_dir(images_dir):
    """Standard ultralytics convention: .../images/<split> -> .../labels/<split>."""
    return images_dir.replace(f"{os.sep}images{os.sep}", f"{os.sep}labels{os.sep}")


def file_hash(path, block_size=65536):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(block_size), b""):
            h.update(block)
    return h.hexdigest()


def parse_label_file(label_path, num_classes):
    """Returns (objects, errors) where objects is a list of
    (class_id, xc, yc, w, h) tuples and errors is a list of human-readable
    problem descriptions for this file."""
    objects = []
    errors = []
    with open(label_path, "r") as f:
        lines = [l.strip() for l in f if l.strip()]

    for line_no, line in enumerate(lines, start=1):
        parts = line.split()
        if len(parts) != 5:
            errors.append(f"line {line_no}: expected 5 values, got {len(parts)} ('{line}')")
            continue
        try:
            cls_id = int(parts[0])
            xc, yc, w, h = (float(p) for p in parts[1:])
        except ValueError:
            errors.append(f"line {line_no}: non-numeric value ('{line}')")
            continue

        if not (0 <= cls_id < num_classes):
            errors.append(f"line {line_no}: class id {cls_id} out of range [0, {num_classes - 1}]")
            continue

        if w <= 0 or h <= 0:
            errors.append(f"line {line_no}: non-positive width/height (w={w}, h={h})")
            continue

        x_min, x_max = xc - w / 2, xc + w / 2
        y_min, y_max = yc - h / 2, yc + h / 2
        if (
            x_min < -BOUNDS_EPSILON or x_max > 1 + BOUNDS_EPSILON
            or y_min < -BOUNDS_EPSILON or y_max > 1 + BOUNDS_EPSILON
        ):
            errors.append(
                f"line {line_no}: box out of [0,1] image bounds "
                f"(x:[{x_min:.4f},{x_max:.4f}] y:[{y_min:.4f},{y_max:.4f}])"
            )
            continue

        objects.append((cls_id, xc, yc, w, h))

    return objects, errors


def validate_split(split_name, images_dir, names):
    labels_dir = images_dir_to_labels_dir(images_dir)
    num_classes = len(names)

    stats = {
        "split": split_name,
        "images_dir": images_dir,
        "labels_dir": labels_dir,
        "total_images": 0,
        "total_labels": 0,
        "missing_labels": [],       # images with no matching label file
        "orphaned_labels": [],      # label files with no matching image
        "empty_labels": [],
        "invalid_label_files": {},  # path -> [error strings]
        "corrupted_images": [],
        "tiny_boxes": 0,
        "images_per_class": defaultdict(set),   # class_id -> set of image paths
        "objects_per_class": defaultdict(int),  # class_id -> count
        "image_hashes": {},         # hash -> [paths]
    }

    if not os.path.isdir(images_dir):
        stats["dir_missing"] = True
        return stats
    stats["dir_missing"] = False

    image_paths = sorted(
        p for p in glob.glob(os.path.join(images_dir, "*"))
        if os.path.splitext(p)[1].lower() in IMAGE_EXTENSIONS
    )
    stats["total_images"] = len(image_paths)

    label_paths = set(glob.glob(os.path.join(labels_dir, "*.txt"))) if os.path.isdir(labels_dir) else set()
    matched_labels = set()

    for img_path in image_paths:
        base = os.path.splitext(os.path.basename(img_path))[0]
        label_path = os.path.join(labels_dir, base + ".txt")

        # Corrupted-image check
        if cv2 is not None:
            img = cv2.imread(img_path)
            if img is None:
                stats["corrupted_images"].append(img_path)
                continue

        # Duplicate-image check (exact byte match)
        h = file_hash(img_path)
        stats["image_hashes"].setdefault(h, []).append(img_path)

        if not os.path.exists(label_path):
            stats["missing_labels"].append(img_path)
            continue

        matched_labels.add(label_path)
        stats["total_labels"] += 1

        if os.path.getsize(label_path) == 0:
            stats["empty_labels"].append(label_path)
            continue

        objects, errors = parse_label_file(label_path, num_classes)
        if errors:
            stats["invalid_label_files"][label_path] = errors

        for cls_id, xc, yc, w, h_norm in objects:
            stats["objects_per_class"][cls_id] += 1
            stats["images_per_class"][cls_id].add(img_path)
            if (w * h_norm) < TINY_BOX_AREA_FRACTION:
                stats["tiny_boxes"] += 1

    stats["orphaned_labels"] = sorted(label_paths - matched_labels)
    return stats


def print_split_report(stats, names):
    print(f"\n{'=' * 60}")
    print(f"SPLIT: {stats['split']}  ({stats['images_dir']})")
    print(f"{'=' * 60}")

    if stats.get("dir_missing"):
        print("  Directory does not exist -- skipped.")
        return

    print(f"Total images:       {stats['total_images']}")
    print(f"Total labels:       {stats['total_labels']}")
    print(f"Missing labels:     {len(stats['missing_labels'])}")
    print(f"Orphaned labels:    {len(stats['orphaned_labels'])}  (label file with no matching image)")
    print(f"Empty label files:  {len(stats['empty_labels'])}")
    print(f"Invalid labels:     {len(stats['invalid_label_files'])}  (files with at least one malformed line)")
    print(f"Corrupted images:   {len(stats['corrupted_images'])}")
    print(f"Tiny bounding boxes: {stats['tiny_boxes']}  (area < {TINY_BOX_AREA_FRACTION:.4%} of frame)")

    dupes = {h: paths for h, paths in stats["image_hashes"].items() if len(paths) > 1}
    dupe_count = sum(len(p) - 1 for p in dupes.values())
    print(f"Duplicate images:   {dupe_count}  (in {len(dupes)} duplicate group(s))")

    print("\nImages per class / Objects per class:")
    print(f"  {'class':14s} {'images':>10s} {'objects':>10s}")
    for cls_id in sorted(names.keys()):
        n_images = len(stats["images_per_class"].get(cls_id, ()))
        n_objects = stats["objects_per_class"].get(cls_id, 0)
        print(f"  {names[cls_id]:14s} {n_images:>10d} {n_objects:>10d}")

    if stats["missing_labels"][:5]:
        print("\nExample images missing labels:")
        for p in stats["missing_labels"][:5]:
            print(f"  - {p}")

    if stats["invalid_label_files"]:
        print("\nExample invalid label files:")
        for p, errs in list(stats["invalid_label_files"].items())[:5]:
            print(f"  - {p}:")
            for e in errs[:3]:
                print(f"      {e}")


def main():
    data_yaml = sys.argv[1] if len(sys.argv) > 1 else "dataset/data.yaml"
    if not os.path.exists(data_yaml):
        print(f"data.yaml not found: {data_yaml}")
        sys.exit(1)

    names, splits, _ = load_data_yaml(data_yaml)
    print(f"Classes ({len(names)}): {names}")

    if not splits:
        print("No train/val/test entries found in data.yaml.")
        sys.exit(1)

    all_stats = {}
    all_hashes = defaultdict(list)  # hash -> [(split, path), ...] across ALL splits
    total_images = 0

    for split_name, images_dir in splits.items():
        stats = validate_split(split_name, images_dir, names)
        all_stats[split_name] = stats
        print_split_report(stats, names)
        total_images += stats["total_images"]
        for h, paths in stats.get("image_hashes", {}).items():
            for p in paths:
                all_hashes[h].append((split_name, p))

    # Cross-split duplicate / leakage check -- the same image appearing in
    # more than one split artificially inflates validation/test accuracy.
    cross_split_dupes = {
        h: entries for h, entries in all_hashes.items()
        if len({split for split, _ in entries}) > 1
    }

    print(f"\n{'=' * 60}")
    print("AGGREGATE / DATASET-WIDE")
    print(f"{'=' * 60}")
    print(f"Total images across all splits: {total_images}")
    print(f"Cross-split duplicate images:   {sum(len(v) for v in cross_split_dupes.values())} "
          f"(in {len(cross_split_dupes)} group(s)) "
          f"{'  <-- DATA LEAKAGE, fix before training!' if cross_split_dupes else ''}")

    if cross_split_dupes:
        print("\nExample cross-split duplicates:")
        for h, entries in list(cross_split_dupes.items())[:5]:
            print(f"  - {[f'{s}:{os.path.basename(p)}' for s, p in entries]}")

    # Class imbalance summary across the whole dataset.
    totals = defaultdict(int)
    for stats in all_stats.values():
        for cls_id, count in stats["objects_per_class"].items():
            totals[cls_id] += count

    if totals:
        print("\nClass distribution (all splits combined):")
        max_count = max(totals.values())
        for cls_id in sorted(names.keys()):
            count = totals.get(cls_id, 0)
            ratio = (count / max_count) if max_count else 0
            bar = "#" * int(ratio * 30)
            print(f"  {names[cls_id]:14s} {count:>8d}  {bar}")

        ambulance_id = next((cid for cid, n in names.items() if n.lower() == "ambulance"), None)
        if ambulance_id is not None:
            ambulance_count = totals.get(ambulance_id, 0)
            if ambulance_count == 0:
                print(
                    "\n  WARNING: zero 'ambulance' labeled objects in the dataset. The model "
                    "cannot learn to detect ambulances at all -- emergency detection will "
                    "never trigger regardless of training."
                )
            elif max_count and ambulance_count < 0.15 * max_count:
                print(
                    f"\n  WARNING: 'ambulance' has only {ambulance_count} labeled objects vs "
                    f"{max_count} for the largest class -- this imbalance will likely make "
                    f"ambulance recall/precision noticeably worse than the other classes. "
                    f"Add more ambulance examples (different views/lighting/models) rather "
                    f"than duplicating existing images."
                )
    else:
        print(
            "\nNo labeled objects found anywhere in the dataset. Populate "
            "dataset/images/{train,val,test} and dataset/labels/{train,val,test} "
            "before running train.py."
        )

    if total_images == 0:
        print("\nRESULT: Dataset is empty -- nothing to train on yet.")
        sys.exit(2)


if __name__ == "__main__":
    main()
