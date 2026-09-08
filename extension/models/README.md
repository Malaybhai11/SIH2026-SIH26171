# Model files

Drop the quantized ONNX models here to switch the vision pipeline out of **mock mode**.
Filenames must match `docs/model-contract.md`:

| file | model | notes |
|---|---|---|
| `blazeface_int8.onnx` | Face detector (Model A) | dynamic INT8, opset 17, input `1x3x128x128` |
| `tinyvit_screen_int8.onnx` | Screen/region classifier (Model B) | static INT8, input `1x3x224x224`, 6 logits |
| `distilbert_ner_int8.onnx` | PII NER (Model C) | INT8, seq 256, 9 BIO tags |
| `bert_vocab.json` | WordPiece vocab for Model C tokenisation | |

Also copy the ONNX Runtime Web wasm artifacts (`ort-wasm-simd-threaded.*`) here if you
bundle them locally instead of letting `onnxruntime-web` resolve its own.

These files are git-ignored. Without them, `visionPipeline.getMode()` returns `"mock"` and
the pipeline derives deterministic outputs from the screenshot + DOM hints so the full
agent loop still runs offline (see `docs/model-contract.md` → "Mock-mode behaviour").

## Export recipe (track C)

```
PyTorch checkpoint
  → torch.onnx.export(..., opset_version=17, dynamic_axes=None)   # static shapes
  → onnxruntime.quantization.quantize_dynamic(...)   # BlazeFace / NER
  → onnxruntime.quantization.quantize_static(..., calibration_data_reader=...)   # TinyViT
```

Calibration set for TinyViT: ~200 screenshots across login / feed / form / checkout pages,
placed in `eval/screen_state_test_set/` (also used for accuracy scoring).
