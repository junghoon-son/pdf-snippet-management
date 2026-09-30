#!/usr/bin/env python3
"""Export a Docling layout model (RT-DETRv2 family) to ONNX for Marklee's
Rust ort pipeline (src-tauri/src/layout.rs).

The export bakes the full pre/post-processing into the graph so the Rust
side stays unchanged:
  inputs : images uint8 [1,3,640,640], orig_target_sizes int64 [1,2] as (w, h)
  outputs: labels int64 [1,300], boxes f32 [1,300,4] (x1,y1,x2,y2 in
           original-image pixels), scores f32 [1,300]

Usage:
  python3 export-layout-onnx.py [--repo ds4sd/docling-layout-heron-101]
                                [--out <path>]
"""

import argparse

import torch
import torch.nn as nn


class LayoutExportWrapper(nn.Module):
    """uint8 CHW in -> (labels, boxes_px, scores) out, post-processor baked in."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, images, orig_target_sizes):
        # Preprocessor config for the heron family: do_rescale=true (1/255),
        # do_normalize=false — the model was trained on [0,1] pixels.
        x = images.float() * (1.0 / 255.0)
        out = self.model(pixel_values=x)
        logits = out.logits        # [1, N, num_classes]
        boxes = out.pred_boxes     # [1, N, 4] cxcywh, normalized 0..1

        probs = torch.sigmoid(logits)
        scores, labels = probs.max(dim=-1)  # [1, N]

        cx, cy, w, h = boxes.unbind(-1)
        xyxy = torch.stack(
            [cx - 0.5 * w, cy - 0.5 * h, cx + 0.5 * w, cy + 0.5 * h], dim=-1
        )
        tw = orig_target_sizes[:, 0].float()  # (w, h) convention — matches layout.rs
        th = orig_target_sizes[:, 1].float()
        scale = torch.stack([tw, th, tw, th], dim=-1).unsqueeze(1)  # [1, 1, 4]
        boxes_px = xyxy * scale
        return labels.to(torch.int64), boxes_px, scores


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="ds4sd/docling-layout-heron-101")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    out_path = args.out or args.repo.split("/")[-1] + ".onnx"

    from transformers import RTDetrV2ForObjectDetection

    print(f"loading {args.repo} …")
    model = RTDetrV2ForObjectDetection.from_pretrained(args.repo)
    model.eval()

    wrapper = LayoutExportWrapper(model)

    # Numerical parity check: torch wrapper vs onnxruntime. IMPORTANT:
    # compute the eager reference BEFORE exporting — tracing caches
    # input-dependent anchors/valid_mask buffers on the module, which
    # poisons any eager forward run after the export.
    import numpy as np
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (816, 1056), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([80, 50, 736, 90], fill=(30, 30, 30))
    for i in range(8):
        d.rectangle([80, 130 + i * 24, 700 - (i % 3) * 50, 140 + i * 24], fill=(120,) * 3)
    d.rectangle([140, 380, 680, 660], outline=(0, 0, 0), width=3)
    d.ellipse([240, 420, 440, 580], fill=(90, 140, 200))
    for i in range(10):
        d.rectangle([80, 700 + i * 24, 690 - (i % 4) * 50, 710 + i * 24], fill=(120,) * 3)
    img640 = img.resize((640, 640))
    arr = np.asarray(img640, dtype=np.uint8).transpose(2, 0, 1)[None].copy()
    sizes_np = np.array([[816, 1056]], dtype=np.int64)

    with torch.no_grad():
        t_labels, t_boxes, t_scores = wrapper(
            torch.from_numpy(arr), torch.from_numpy(sizes_np)
        )

    images = torch.zeros((1, 3, 640, 640), dtype=torch.uint8)
    sizes = torch.tensor([[640, 640]], dtype=torch.int64)

    print(f"exporting to {out_path} …")
    torch.onnx.export(
        wrapper,
        (images, sizes),
        out_path,
        input_names=["images", "orig_target_sizes"],
        output_names=["labels", "boxes", "scores"],
        opset_version=17,
        dynamo=False,
    )

    import onnxruntime as ort

    sess = ort.InferenceSession(out_path)
    o_labels, o_boxes, o_scores = sess.run(
        None,
        {"images": arr, "orig_target_sizes": sizes_np},
    )

    assert o_labels.shape == tuple(t_labels.shape), (o_labels.shape, t_labels.shape)
    score_diff = np.abs(o_scores - t_scores.numpy()).max()
    box_diff = np.abs(o_boxes - t_boxes.numpy()).max()
    label_match = (o_labels == t_labels.numpy()).mean()
    print(f"parity: max|Δscore|={score_diff:.2e}  max|Δbox|={box_diff:.3f}px  "
          f"label agreement={label_match:.4f}")
    assert score_diff < 1e-2, "score mismatch"
    assert box_diff < 2.0, "box mismatch"
    assert label_match > 0.999, "label mismatch"

    id2label = model.config.id2label or {}
    print("top detections (onnxruntime):")
    order = np.argsort(-o_scores[0])[:8]
    for i in order:
        s = float(o_scores[0, i])
        if s < 0.3:
            continue
        b = o_boxes[0, i]
        cls = int(o_labels[0, i])
        name = id2label.get(cls, id2label.get(str(cls), str(cls)))
        print(f"  {name:<16} {s:.2f}  "
              f"[{b[0]:.0f}, {b[1]:.0f}, {b[2]:.0f}, {b[3]:.0f}]")
    print(f"OK — {out_path}")


if __name__ == "__main__":
    main()
