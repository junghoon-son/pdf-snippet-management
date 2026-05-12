// RT-DETR document layout detector via ONNX Runtime.
//
// Model: Kreuzberg/layout-models (Apache 2.0) — RT-DETR trained on
// document layouts with 17 classes (Caption, Footnote, Formula,
// ListItem, PageFooter, PageHeader, Picture, SectionHeader, Table,
// Text, Title, DocumentIndex, Code, CheckboxSelected,
// CheckboxUnselected, Form, KeyValueRegion).
//
// We use the model to detect Picture / Table / Formula regions and
// return them as figure candidates to Marklee. Caption regions are
// extracted separately so we can pair them with adjacent figures.
//
// Replaces the slow Ollama+VLM path for layout. Pure inference, no
// LLM tokenization, ~10-50× faster on the same hardware.

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
    "https://huggingface.co/Kreuzberg/layout-models/resolve/main/rtdetr/model.onnx";
const MODEL_FILE: &str = "kreuzberg-rtdetr.onnx";
const INPUT_SIZE: u32 = 640;
const CONF_THRESH: f32 = 0.25;
const IOU_THRESH: f32 = 0.55;
// Expand each detected box by this fraction of orig_w/orig_h on each
// side, so captions and axis labels that hug the figure aren't cropped.
const BOX_MARGIN: f32 = 0.015;

/// ImageNet normalization constants (channel-wise).
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

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

        // Letterbox to INPUT_SIZE × INPUT_SIZE preserving aspect ratio.
        let scale = (INPUT_SIZE as f32 / orig_w as f32).min(INPUT_SIZE as f32 / orig_h as f32);
        let new_w = (orig_w as f32 * scale).round() as u32;
        let new_h = (orig_h as f32 * scale).round() as u32;
        let pad_x = (INPUT_SIZE - new_w) / 2;
        let pad_y = (INPUT_SIZE - new_h) / 2;
        let resized = img
            .resize_exact(new_w, new_h, image::imageops::FilterType::Triangle)
            .to_rgb8();
        let mut canvas = image::RgbImage::from_pixel(INPUT_SIZE, INPUT_SIZE, image::Rgb([114, 114, 114]));
        image::imageops::replace(&mut canvas, &resized, pad_x as i64, pad_y as i64);

        // CHW float32 with ImageNet normalization.
        let mut input = Array4::<f32>::zeros((1, 3, INPUT_SIZE as usize, INPUT_SIZE as usize));
        for (x, y, p) in canvas.enumerate_pixels() {
            let [r, g, b] = p.0;
            input[[0, 0, y as usize, x as usize]] = ((r as f32 / 255.0) - MEAN[0]) / STD[0];
            input[[0, 1, y as usize, x as usize]] = ((g as f32 / 255.0) - MEAN[1]) / STD[1];
            input[[0, 2, y as usize, x as usize]] = ((b as f32 / 255.0) - MEAN[2]) / STD[2];
        }

        // Inference. The Kreuzberg RT-DETR export has two required
        // inputs:
        //   1. the image tensor (1×3×640×640)
        //   2. orig_target_sizes — a [1, 2] int64 tensor of (h, w) for
        //      the ORIGINAL image. The model's baked-in post-processor
        //      uses this to scale predictions back to original-image
        //      pixel coords. Without it, the Expand node errors out.
        let mut guard = self.session.lock().map_err(|e| e.to_string())?;
        let session = guard.as_mut().ok_or("session not initialized")?;
        let input_tensor = Tensor::from_array(input).map_err(|e| e.to_string())?;
        // Pass orig_target_sizes = (INPUT_SIZE, INPUT_SIZE) so the
        // post-processor returns coords in the 640×640 letterboxed
        // space directly. We then subtract pad and divide by scale to
        // map back to original-image pixels. This avoids axis-order
        // ambiguity in the export and the post-processor's lack of
        // awareness of our letterbox padding.
        let target_sizes_arr = ndarray::Array2::<i64>::from_shape_vec(
            (1, 2),
            vec![INPUT_SIZE as i64, INPUT_SIZE as i64],
        ).map_err(|e| e.to_string())?;
        let target_sizes = Tensor::from_array(target_sizes_arr)
            .map_err(|e| e.to_string())?;
        let outputs = session
            .run(ort::inputs![input_tensor, target_sizes])
            .map_err(|e| format!("inference failed: {}", e))?;

        // Kreuzberg's RT-DETR exports three named outputs: labels, boxes,
        // scores. Output names may be "labels"/"boxes"/"scores" or just
        // ordered. Read by index since name lookup is finicky.
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

        let dets = parse_detections(
            &labels, &boxes, &scores,
            orig_w as f32, orig_h as f32,
            pad_x as f32, pad_y as f32, scale,
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
    pad_x: f32,
    pad_y: f32,
    scale: f32,
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

        // Raw boxes are in 640×640 letterboxed pixel space (we passed
        // orig_target_sizes=(INPUT_SIZE, INPUT_SIZE)). Un-letterbox by
        // subtracting pad and dividing by the resize scale, then expand
        // by a small margin so the rect doesn't crop captions / axis
        // labels that hug the figure.
        let mx = orig_w * BOX_MARGIN;
        let my = orig_h * BOX_MARGIN;
        let lx1 = ((b0 - pad_x) / scale - mx).clamp(0.0, orig_w);
        let ly1 = ((b1 - pad_y) / scale - my).clamp(0.0, orig_h);
        let lx2 = ((b2 - pad_x) / scale + mx).clamp(0.0, orig_w);
        let ly2 = ((b3 - pad_y) / scale + my).clamp(0.0, orig_h);
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
