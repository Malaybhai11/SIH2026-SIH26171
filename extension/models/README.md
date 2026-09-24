# Model files

```bash
npm run fetch-models        # ~52 MB: YuNet, MobileCLIP-S0 image tower (FP16), BERT-small PII (INT8)
npm run build:clip-labels   # optional: re-embed the zero-shot prompts (downloads the 170 MB text tower)
```

`clip_labels.json` (prompt embeddings) is committed, so the text tower is only needed if
you edit the prompts in `scripts/build_clip_labels.mjs`. Everything else here is
git-ignored and copied into `dist/models/` by the build. See `docs/model-contract.md`
for tensor shapes, pre/post-processing and why each precision was chosen.
