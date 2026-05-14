// RT-DETR v2 document layout detector via ONNX Runtime.
//
// Model: docling-project/docling-layout-heron-onnx (Apache 2.0) — the
// official Docling project layout model, 42.9M params, ~171 MB ONNX.
// Same 17-class taxonomy as the older Kreuzberg export (Caption,
// Footnote, Formula, ListItem, PageFooter, PageHeader, Picture,
// SectionHeader, Table, Text, Title, DocumentIndex, Code,
// CheckboxSelected, CheckboxUnselected, Form, KeyValueRegion) but
// trained as RT-DETR v2 with improved accuracy.
//
// Preprocessing differences from Kreuzberg:
//   * Plain resize to 640×640 (NOT aspect-preserving letterbox).
//   * Input is float32 RGB in [0, 255] — the model's exported graph
//     handles normalization internally (preprocessor_config.json has
//     do_normalize: false, do_rescale: false). No ImageNet mean/std
//     applied on our side.
//   * orig_target_sizes follows HF's textbook (h, w) convention.
//   * Post-processor returns boxes in original-image pixel coords;
//     no manual un-letterbox needed (we never padded).
//
// We surface Picture / Table / Formula regions as figure candidates.

use image::ImageReader;
use ndarray::{Array, Array4, IxDyn};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

/// Class index → label map from Kreuzberg/layout-models README.
const CLASS_LABELS: &[&str] = &[
    "Caption",        // 0
    "Footnote",       // 1
    "Formula",        // 2
    "ListItem",       // 3
    "PageFooter",     // 4
    "PageHeader",     // 5
    "Picture",        // 6  ← figure
    "SectionHeader",  // 7
    "Table",          // 8  ← table
    "Text",           // 9
    "Title",          // 10
    "DocumentIndex",  // 11
    "Code",           // 12
    "CheckboxSelected",   // 13
    "CheckboxUnselected", // 14
    "Form",           // 15
    "KeyValueRegion", // 16
];

/// Classes we surface as figure-like candidates (image highlights).
fn figure_kind_for(class_id: u32) -> Option<&'static str> {
    match class_id {
        6 => Some("figure"),  // Picture
        8 => Some("table"),
        2 => Some("formula"), // Formulas rendered as images
        _ => None,
    }
}

const MODEL_URL: &str =
    "https://huggingface.co/docling-project/docling-layout-heron-onnx/resolve/main/model.onnx";
const MODEL_FILE: &str = "docling-heron-rtdetrv2.onnx";
const INPUT_SIZE: u32 = 640;
const CONF_THRESH: f32 = 0.40;
const IOU_THRESH: f32 = 0.55;
// Expand each detected box by this fraction of orig_w/orig_h on each
// side, so captions and axis labels that hug the figure aren't cropped.
// Heron's boxes are already tight to content, so 0.005 (0.5%) is enough
// — bigger margins push into adjacent text columns.
const BOX_MARGIN: f32 = 0.005;

#[derive(Serialize, Clone, Debug)]
pub struct DetectionBox {
    /// Canonical Marklee kind: "figure" | "table" | "formula"
    pub kind: String,
    /// Raw class index from the model (for debugging / future use).
    pub class_id: u32,
    /// Class label from the model.
    pub class_label: String,
    pub confidence: f32,
    /// Normalized 0..1, top-left origin (relative to original image).
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

pub struct LayoutEngine {
    session: Mutex<Option<Session>>,
}

impl LayoutEngine {
    pub fn new() -> Self {
        Self { session: Mutex::new(None) }
    }

    fn cache_dir() -> Result<PathBuf, String> {
        let dir = dirs::data_dir()
            .ok_or_else(|| "no platform data dir".to_string())?
            .join("Marklee")
            .join("models");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    /// First-run download. Returns absolute path to the cached .onnx.
    fn ensure_model() -> Result<PathBuf, String> {
        let dir = Self::cache_dir()?;
        let path = dir.join(MODEL_FILE);
        // Treat any file >1MB as a complete download (anti-truncation).
        if path.exists()
            && std::fs::metadata(&path).map(|m| m.len() > 1024 * 1024).unwrap_or(false)
        {
            return Ok(path);
        }
        // Download via ureq. Hugging Face redirects to S3; ureq follows.
        let resp = ureq::get(MODEL_URL)
            .call()
            .map_err(|e| format!("model download failed: {}", e))?;
        let mut reader = resp.into_reader();
        // Write to a temp path first, rename on success. Avoids leaving
        // half-files if the download is interrupted.
        let tmp = path.with_extension("onnx.partial");
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        Ok(path)
    }

    fn ensure_session(&self) -> Result<(), String> {
        let mut guard = self.session.lock().map_err(|e| e.to_string())?;
        if guard.is_some() { return Ok(()); }
        let path = Self::ensure_model()?;
        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| e.to_string())?
            .with_intra_threads(4)
            .map_err(|e| e.to_string())?
            .commit_from_file(&path)
            .map_err(|e| format!("session load failed: {}", e))?;
        *guard = Some(session);
        Ok(())
    }

    /// Run RT-DETR inference on a single image (PNG/JPEG bytes).
    pub fn detect(&self, image_bytes: &[u8]) -> Result<Vec<DetectionBox>, String> {
        self.ensure_session()?;

        // Load image, capture original dims.
        let img = ImageReader::new(std::io::Cursor::new(image_bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .decode()
            .map_err(|e| e.to_string())?;
        let (orig_w, orig_h) = (img.width(), img.height());

        // Plain resize to INPUT_SIZE × INPUT_SIZE — heron's preprocessor
        // does NOT letterbox / pad. Aspect distortion is acceptable for
        // document layout (mostly portrait pages anyway).
        let resized = img
            .resize_exact(INPUT_SIZE, INPUT_SIZE, image::imageops::FilterType::Triangle)
            .to_rgb8();

        // CHW uint8. Heron's ONNX graph expects tensor(uint8) — the
        // graph handles its own rescale + ImageNet normalization
        // internally. Sending float32 fails with a type mismatch.
        let mut input = Array4::<u8>::zeros((1, 3, INPUT_SIZE as usize, INPUT_SIZE as usize));
        for (x, y, p) in resized.enumerate_pixels() {
            let [r, g, b] = p.0;
            input[[0, 0, y as usize, x as usize]] = r;
            input[[0, 1, y as usize, x as usize]] = g;
            input[[0, 2, y as usize, x as usize]] = b;
        }

        // Inference. heron's RT-DETR v2 export takes two inputs:
        //   1. image tensor (1×3×640×640, uint8)
        //   2. orig_target_sizes — int64 [1, 2] of (width, height) for
        //      the original image. Note: this is (w, h), NOT the
        //      textbook HF (h, w) — confirmed empirically by the
        //      diagnostic dump (raw box x-maxes were ≈1288 for a
        //      1024×1303 input, only fitting in [0, 1303]; y-maxes
        //      ≈1003, fitting in [0, 1024]). Kreuzberg's export had
        //      the same axis-swap quirk.
        let mut guard = self.session.lock().map_err(|e| e.to_string())?;
        let session = guard.as_mut().ok_or("session not initialized")?;

        // Log session input/output metadata on first call so we know
        // exactly what dtype and shape heron's ONNX expects (uint8 vs
        // float32, with/without target_sizes, etc).
        static SESSION_LOGGED: std::sync::Once = std::sync::Once::new();
        SESSION_LOGGED.call_once(|| {
            use std::io::Write;
            let mut s = String::from("[heron-diag] session metadata\n");
            for (i, inp) in session.inputs.iter().enumerate() {
                s.push_str(&format!("[heron-diag]   input[{}] name={:?} type={:?}\n", i, inp.name, inp.input_type));
            }
            for (i, out) in session.outputs.iter().enumerate() {
                s.push_str(&format!("[heron-diag]   output[{}] name={:?} type={:?}\n", i, out.name, out.output_type));
            }
            eprintln!("{}", s);
            let _ = std::fs::File::create("/tmp/marklee-heron-session.log")
                .and_then(|mut f| f.write_all(s.as_bytes()));
        });

        let input_tensor = Tensor::from_array(input).map_err(|e| e.to_string())?;
        let target_sizes_arr = ndarray::Array2::<i64>::from_shape_vec(
            (1, 2),
            vec![orig_w as i64, orig_h as i64],
        ).map_err(|e| e.to_string())?;
        let target_sizes = Tensor::from_array(target_sizes_arr)
            .map_err(|e| e.to_string())?;
        let outputs = match session.run(ort::inputs![input_tensor, target_sizes]) {
            Ok(o) => o,
            Err(e) => {
                let msg = format!("[heron-diag] session.run failed: {}\n", e);
                eprintln!("{}", msg);
                let _ = std::fs::write("/tmp/marklee-heron-runerr.log", &msg);
                return Err(format!("inference failed: {}", e));
            }
        };

        // Confirmed (via session.inputs/outputs log): heron returns 3
        // outputs — labels (i64 [1, 300]), boxes (f32 [1, 300, 4]),
        // scores (f32 [1, 300]). Same shape as Kreuzberg.
        if outputs.len() < 3 {
            return Err(format!("expected 3 outputs, got {}", outputs.len()));
        }
        let mut out_iter = outputs.iter();
        let labels_v = out_iter.next().unwrap().1;
        let boxes_v = out_iter.next().unwrap().1;
        let scores_v = out_iter.next().unwrap().1;

        // Try to extract each. labels is i64; boxes + scores are f32.
        let labels: Array<i64, IxDyn> = labels_v
            .try_extract_array::<i64>()
            .map_err(|e| format!("labels extract failed: {}", e))?
            .into_owned();
        let boxes: Array<f32, IxDyn> = boxes_v
            .try_extract_array::<f32>()
            .map_err(|e| format!("boxes extract failed: {}", e))?
            .into_owned();
        let scores: Array<f32, IxDyn> = scores_v
            .try_extract_array::<f32>()
            .map_err(|e| format!("scores extract failed: {}", e))?
            .into_owned();

        // One-shot diagnostic dump so we can verify the post-processor's
        // coordinate space — comparing raw box max against orig_w/orig_h
        // tells us whether (h, w) vs (w, h) is right and whether the
        // coords are pixels vs normalized. Writes to /tmp AND to the
        // model cache dir; also eprints so it lands in tauri-dev.log.
        static DUMPED: std::sync::Once = std::sync::Once::new();
        DUMPED.call_once(|| {
            use std::io::Write;
            eprintln!("[heron-diag] entering one-shot diagnostic dump");
            let path: std::path::PathBuf = std::path::PathBuf::from("/tmp/marklee-heron.log");
            let alt_path: Option<std::path::PathBuf> = Self::cache_dir()
                .ok()
                .map(|d| d.join("layout.log"));
            let bshape = boxes.shape();
            let n = if bshape.len() == 3 { bshape[1] } else { bshape[0] };
            let mut s = String::new();
            s.push_str(&format!(
                "[heron] shapes — labels: {:?} boxes: {:?} scores: {:?}\n",
                labels.shape(), boxes.shape(), scores.shape()
            ));
            s.push_str(&format!(
                "[heron] orig dims: {}×{} (w×h), INPUT_SIZE={}\n",
                orig_w, orig_h, INPUT_SIZE
            ));
            let mut max_b0 = f32::MIN; let mut max_b1 = f32::MIN;
            let mut max_b2 = f32::MIN; let mut max_b3 = f32::MIN;
            for i in 0..n.min(50) {
                let (b0, b1, b2, b3) = if bshape.len() == 3 {
                    (boxes[[0, i, 0]], boxes[[0, i, 1]], boxes[[0, i, 2]], boxes[[0, i, 3]])
                } else {
                    (boxes[[i, 0]], boxes[[i, 1]], boxes[[i, 2]], boxes[[i, 3]])
                };
                max_b0 = max_b0.max(b0); max_b1 = max_b1.max(b1);
                max_b2 = max_b2.max(b2); max_b3 = max_b3.max(b3);
            }
            s.push_str(&format!(
                "[heron] raw box channel maxes — b0(x1?)={:.2} b1(y1?)={:.2} b2(x2?)={:.2} b3(y2?)={:.2}\n",
                max_b0, max_b1, max_b2, max_b3
            ));
            s.push_str("[heron] interpretation guide:\n");
            s.push_str(&format!(
                "[heron]   - if b0/b2 ∈ [0, ~{}] and b1/b3 ∈ [0, ~{}] → pixel coords (x1,y1,x2,y2), our math is right\n",
                orig_w, orig_h
            ));
            s.push_str(&format!(
                "[heron]   - if b0/b2 ∈ [0, ~{}] and b1/b3 ∈ [0, ~{}] → axis-swapped, flip target_sizes\n",
                orig_h, orig_w
            ));
            s.push_str("[heron]   - if all maxes ≤ 1 → normalized, post-processor not baked, decode needed\n");
            let bshape3 = bshape.len() == 3;
            let dump_n = n.min(8);
            for i in 0..dump_n {
                let (b0, b1, b2, b3) = if bshape3 {
                    (boxes[[0, i, 0]], boxes[[0, i, 1]], boxes[[0, i, 2]], boxes[[0, i, 3]])
                } else {
                    (boxes[[i, 0]], boxes[[i, 1]], boxes[[i, 2]], boxes[[i, 3]])
                };
                let conf = if scores.shape().len() == 2 { scores[[0, i]] } else { scores[[i]] };
                let cls = if labels.shape().len() == 2 { labels[[0, i]] } else { labels[[i]] };
                s.push_str(&format!(
                    "[heron] det[{}] cls={} conf={:.3} box=({:.2}, {:.2}, {:.2}, {:.2})\n",
                    i, cls, conf, b0, b1, b2, b3
                ));
            }
            eprintln!("{}", s);
            match std::fs::File::create(&path).and_then(|mut f| f.write_all(s.as_bytes())) {
                Ok(_) => eprintln!("[heron-diag] wrote {}", path.display()),
                Err(e) => eprintln!("[heron-diag] /tmp write failed: {}", e),
            }
            if let Some(alt) = alt_path {
                match std::fs::File::create(&alt).and_then(|mut f| f.write_all(s.as_bytes())) {
                    Ok(_) => eprintln!("[heron-diag] also wrote {}", alt.display()),
                    Err(e) => eprintln!("[heron-diag] cache_dir write failed: {}", e),
                }
            }
        });

        let dets = parse_detections(
            &labels, &boxes, &scores,
            orig_w as f32, orig_h as f32,
        );
        Ok(nms(dets, IOU_THRESH))
    }
}

fn parse_detections(
    labels: &Array<i64, IxDyn>,
    boxes: &Array<f32, IxDyn>,
    scores: &Array<f32, IxDyn>,
    orig_w: f32,
    orig_h: f32,
) -> Vec<DetectionBox> {
    // boxes shape: [batch, N, 4] OR [N, 4]. Handle both.
    let bshape = boxes.shape();
    let n = if bshape.len() == 3 { bshape[1] } else { bshape[0] };
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let (b0, b1, b2, b3) = if bshape.len() == 3 {
            (boxes[[0, i, 0]], boxes[[0, i, 1]], boxes[[0, i, 2]], boxes[[0, i, 3]])
        } else {
            (boxes[[i, 0]], boxes[[i, 1]], boxes[[i, 2]], boxes[[i, 3]])
        };
        let conf = if scores.shape().len() == 2 { scores[[0, i]] } else { scores[[i]] };
        if conf < CONF_THRESH { continue; }
        let class_id = if labels.shape().len() == 2 { labels[[0, i]] } else { labels[[i]] } as u32;
        let kind = match figure_kind_for(class_id) {
            Some(k) => k,
            None => continue, // not a figure-like class
        };

        // Boxes are already in original-image pixel coordinates — the
        // post-processor used orig_target_sizes=(orig_h, orig_w). No
        // letterbox or pad to undo. Just expand outward by a small
        // margin so the rect doesn't crop captions / axis labels.
        let mx = orig_w * BOX_MARGIN;
        let my = orig_h * BOX_MARGIN;
        let lx1 = (b0 - mx).clamp(0.0, orig_w);
        let ly1 = (b1 - my).clamp(0.0, orig_h);
        let lx2 = (b2 + mx).clamp(0.0, orig_w);
        let ly2 = (b3 + my).clamp(0.0, orig_h);
        let left = lx1.min(lx2);
        let top = ly1.min(ly2);
        let w = (lx2 - lx1).abs();
        let h = (ly2 - ly1).abs();
        if w <= 0.0 || h <= 0.0 { continue; }
        let class_label = CLASS_LABELS
            .get(class_id as usize)
            .copied()
            .unwrap_or("unknown")
            .to_string();
        out.push(DetectionBox {
            kind: kind.to_string(),
            class_id,
            class_label,
            confidence: conf,
            left: left / orig_w,
            top: top / orig_h,
            width: w / orig_w,
            height: h / orig_h,
        });
    }
    out
}

fn iou(a: &DetectionBox, b: &DetectionBox) -> f32 {
    let ax2 = a.left + a.width; let ay2 = a.top + a.height;
    let bx2 = b.left + b.width; let by2 = b.top + b.height;
    let ix1 = a.left.max(b.left); let iy1 = a.top.max(b.top);
    let ix2 = ax2.min(bx2);       let iy2 = ay2.min(by2);
    let iw = (ix2 - ix1).max(0.0); let ih = (iy2 - iy1).max(0.0);
    let inter = iw * ih;
    let uni = a.width * a.height + b.width * b.height - inter;
    if uni <= 0.0 { 0.0 } else { inter / uni }
}

fn nms(mut dets: Vec<DetectionBox>, thresh: f32) -> Vec<DetectionBox> {
    dets.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<DetectionBox> = Vec::new();
    for d in dets {
        if kept.iter().any(|k| k.class_id == d.class_id && iou(k, &d) > thresh) {
            continue;
        }
        kept.push(d);
    }
    kept
}
