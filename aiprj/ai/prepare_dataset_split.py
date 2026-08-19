"""
Splits a flat folder of extracted video frames (+ YOLO labels) into
dataset/images/{train,val,test} and dataset/labels/{train,val,test} WITHOUT
letting frames from the same source video end up in more than one split.

Why this exists: randomly shuffling individual frames into train/val/test is
the single most common way to accidentally produce a model that scores
artificially high in validation -- adjacent frames from the same video clip
are nearly identical, so if frame 104 lands in train and frame 105 lands in
val, val performance is really just "memorized this video," not real
generalization. This script groups frames by source video FIRST, then
assigns whole groups to a split, so no video is ever split across sets.

Assumes frame filenames encode their source video, e.g. frames extracted
with ffmpeg like:
    north_intersection_2024-01-05_frame_0001.jpg
    north_intersection_2024-01-05_frame_0002.jpg
    ambulance_clip_07_frame_0001.jpg

Usage:
    python prepare_dataset_split.py --images path/to/all_frames --labels path/to/all_labels
        [--train 0.7] [--val 0.2] [--test 0.1]
        [--group-pattern "^(.*)_frame_\\d+$"]
        [--seed 0] [--dry-run]

If your dataset already has a valid, leakage-safe split (e.g. one you got
from Roboflow with train/val/test already separated), don't run this --
just point dataset/data.yaml at it directly and run validate_dataset.py to
confirm it's clean instead.
"""
import argparse
import os
import re
import shutil
import random
from collections import defaultdict

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

DEFAULT_GROUP_PATTERN = r"^(.*)_frame_\d+$"


def group_key(filename, pattern):
    stem = os.path.splitext(filename)[0]
    match = re.match(pattern, stem)
    if match:
        return match.group(1)
    # No pattern match -- treat the whole filename as its own group (safest
    # fallback: worst case it behaves like per-image splitting for files
    # that don't follow the naming convention, but never silently guesses).
    return stem


def greedy_group_split(groups, train_ratio, val_ratio, test_ratio, seed):
    """Assigns whole groups (lists of filenames) to train/val/test using a
    greedy largest-first bin-packing so the resulting image counts land
    close to the requested ratios without ever splitting a group."""
    assert abs(train_ratio + val_ratio + test_ratio - 1.0) < 1e-6, "ratios must sum to 1.0"

    items = list(groups.items())
    rng = random.Random(seed)
    rng.shuffle(items)
    items.sort(key=lambda kv: len(kv[1]), reverse=True)

    total = sum(len(files) for _, files in items)
    targets = {
        "train": total * train_ratio,
        "val": total * val_ratio,
        "test": total * test_ratio,
    }
    current = {"train": 0, "val": 0, "test": 0}
    assignment = {"train": [], "val": [], "test": []}

    for group_id, files in items:
        # Assign to whichever split is furthest below its target (as a
        # fraction of target), skipping splits with a zero target.
        candidates = [s for s in ("train", "val", "test") if targets[s] > 0]
        best_split = min(candidates, key=lambda s: current[s] / targets[s] if targets[s] else float("inf"))
        assignment[best_split].append((group_id, files))
        current[best_split] += len(files)

    return assignment, current, total


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", required=True, help="Folder of all extracted frame images (flat, unsplit)")
    parser.add_argument("--labels", required=True, help="Folder of matching YOLO .txt labels (flat, unsplit)")
    parser.add_argument("--dataset-root", default="dataset", help="Output dataset root (default: dataset/)")
    parser.add_argument("--train", type=float, default=0.7)
    parser.add_argument("--val", type=float, default=0.2)
    parser.add_argument("--test", type=float, default=0.1)
    parser.add_argument("--group-pattern", default=DEFAULT_GROUP_PATTERN,
                         help="Regex with one capture group extracting the source-video id from a frame's filename")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true", help="Print the planned split without copying any files")
    args = parser.parse_args()

    if not os.path.isdir(args.images):
        raise FileNotFoundError(f"--images folder not found: {args.images}")

    image_files = sorted(
        f for f in os.listdir(args.images)
        if os.path.splitext(f)[1].lower() in IMAGE_EXTENSIONS
    )
    if not image_files:
        print(f"No images found in {args.images}.")
        return

    groups = defaultdict(list)
    for f in image_files:
        groups[group_key(f, args.group_pattern)].append(f)

    print(f"{len(image_files)} images across {len(groups)} source-video group(s).")
    if len(groups) < 3:
        print(
            "WARNING: fewer than 3 groups detected -- either --group-pattern isn't matching your "
            "filenames (check it against an example), or you genuinely only have 1-2 source videos, "
            "in which case a video-safe split isn't fully possible and you should record more source "
            "footage before training a model you'll trust the validation numbers of."
        )

    assignment, counts, total = greedy_group_split(groups, args.train, args.val, args.test, args.seed)

    print("\nPlanned split (by image count):")
    for split in ("train", "val", "test"):
        pct = counts[split] / total if total else 0
        n_groups = len(assignment[split])
        print(f"  {split:6s}: {counts[split]:5d} images ({pct:.1%})  from {n_groups} group(s)")

    if args.dry_run:
        print("\n--dry-run: no files copied.")
        return

    for split in ("train", "val", "test"):
        img_out = os.path.join(args.dataset_root, "images", split)
        lbl_out = os.path.join(args.dataset_root, "labels", split)
        os.makedirs(img_out, exist_ok=True)
        os.makedirs(lbl_out, exist_ok=True)

        for group_id, files in assignment[split]:
            for fname in files:
                src_img = os.path.join(args.images, fname)
                shutil.copy2(src_img, os.path.join(img_out, fname))

                label_name = os.path.splitext(fname)[0] + ".txt"
                src_label = os.path.join(args.labels, label_name)
                if os.path.exists(src_label):
                    shutil.copy2(src_label, os.path.join(lbl_out, label_name))
                else:
                    print(f"  WARNING: no label for {fname} (expected {src_label})")

    print(f"\nDone. Files copied into {args.dataset_root}/images|labels/{{train,val,test}}.")
    print("Run validate_dataset.py next to confirm there's no cross-split leakage.")


if __name__ == "__main__":
    main()
