# On-device model contract

Every model runs in the browser through **ONNX Runtime Web** (WebGPU when an adapter
exists, otherwise multi-threaded WASM SIMD; the extension pages are cross-origin
isolated so WASM gets threads). All files are local under `extension/models/`
(`npm run fetch-models`); nothing is downloaded at runtime, and no model sees the
network. The same pre/post-processing code runs in Node (`onnxruntime-node`) for the
evaluation, so the numbers in `eval/results/` describe the shipped code.

| Model | File | Size | Precision | Job |
|---|---|---|---|---|
| YuNet (OpenCV, 2023mar) | `yunet/face_detection_yunet_2023mar.onnx` | 0.2 MB | FP32 | Faces → black boxes |
| MobileCLIP-S0 image tower (Apple) | `Xenova/mobileclip_s0/onnx/vision_model_fp16.onnx` | 22.9 MB | FP16 | Screen state + image-region semantics, zero-shot |
| BERT-small PII (4 layers) | `onnx-community/bert-small-pii-detection-ONNX/onnx/model_quantized.onnx` | 28.7 MB | INT8 | Names / places in visible text |
| Label embeddings | `clip_labels.json` | 0.45 MB | — | 104 prompt embeddings (text tower is build-time only) |

Precision choices are measured, not assumed (see `eval/README.md`):
* YuNet INT8 (QDQ) is 2.6× **slower** than FP32 on the WASM CPU backend → FP32.
* MobileCLIP INT8 (dynamic) destroys zero-shot accuracy (group photo → "chart");
  FP16 is bit-for-bit as accurate as FP32 at half the size, and native on WebGPU.
* BERT-small FP16 does not run on the WASM EP; INT8 is used.

## YuNet — `perception/faces.js`
* Input `input: float32[1,3,640,640]`, **BGR**, raw 0–255, letterboxed (top-left).
* Outputs per stride s∈{8,16,32}: `cls_s, obj_s [1,N,1]`, `bbox_s [1,N,4]`, `kps_s [1,N,10]`.
* Decode: `score = sqrt(clip(cls)·clip(obj))`; `cx=(col+dx)·s, cy=(row+dy)·s, w=e^dw·s, h=e^dh·s`;
  threshold 0.5 (swept on WIDER: P 0.81 / R 0.79), NMS IoU 0.3.
* Runs on (a) a **ROI mosaic**: every image region ≤ 320 px packed into one 640² frame
  (4×4 cells of 160 px — avatars get upscaled into detectable size), (b) crops of large
  images (cached by content hash), (c) the full frame only in `max` mode or when
  cross-origin iframes may hide faces.

## MobileCLIP-S0 — `perception/clip.js`
* Input `pixel_values: float32[B,3,256,256]` RGB, shortest-edge resize 256 + centre crop,
  scaled to [0,1], **no mean/std**. Output `image_embeds [B,512]` → L2-normalised.
* Zero-shot: cosine vs. prompt embeddings × 100 → softmax; classes with several prompts
  are max-pooled. Two label sets: `screen` (18 classes) and `region` (17 classes,
  7 sensitive: face_photo, people_photo, id_card, bank_card, signature, qr_code, document_scan).
* One batched run per frame covers the screen (once per page) and up to 4 uncached
  image regions not already explained by YuNet.
* Screen state = **fusion** with structural DOM counts (`screenFeatures.js`):
  `softmax(log p_clip + prior(features))`. Region sensitivity = vision (top class
  sensitive, or sensitive classes jointly ≥ 0.5) **or** DOM semantics (alt/aria/file name
  says signature/Aadhaar/passport/avatar…).

## BERT-small PII NER — `perception/ner.js`
* Own WordPiece tokenizer (`wordpiece.js`) keeps **character offsets**, so spans map back
  to the original text and from there to pixels (`Range.getClientRects`).
* Inputs `input_ids, attention_mask, token_type_ids: int64[B,T]`, T ≤ 160, batches of 16;
  long text is chunked at 100 words (no truncation). Strings without an uppercase
  letter skip the model.
* Output `logits [B,T,49]` (BIO over 24 entity types). First sub-token labels each word;
  only PERSON → NAME and LOCATION → LOCATION are kept (score ≥ 0.6). Structured types
  (email, phone, cards, Aadhaar…) belong to the checksum-validated rules in `redact.js`.
  Single-word UI vocabulary ("Aadhaar", "Mobile") is filtered.
