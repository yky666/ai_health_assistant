"""Verify prepared local runtime assets; this does not certify offline browser use."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parents[1]
dist = root / "frontend/dist"
manifest_path = dist / "models/manifest.json"
EXPECTED_MODEL_SHA256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"
assert (dist / "index.html").is_file(), "Build the frontend first"
assert manifest_path.is_file(), "Prepare model assets and rebuild"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
model = dist / "models/pose_landmarker_lite.task"
actual_model_sha256 = hashlib.sha256(model.read_bytes()).hexdigest()
assert actual_model_sha256 == EXPECTED_MODEL_SHA256, (
    f"Model digest does not match the pinned reviewed digest: {actual_model_sha256}"
)
assert manifest.get("sha256") == EXPECTED_MODEL_SHA256, (
    "Manifest digest does not match the pinned reviewed digest"
)
for name in manifest["wasm_assets"]:
    assert (dist / "wasm" / name).is_file(), f"Missing WASM asset: {name}"
assert not (root / "frontend/src/smplx_official.json").exists(), "Legacy third-party parameters must not ship"
for asset in (dist / "assets").glob("*.js"):
    assert "SMPLX_NEUTRAL.npz" not in asset.read_text(encoding="utf-8"), "Legacy body parameters in bundle"
print("PASS: pinned model digest, local WASM, built entry, no legacy body-model parameter marker")
print("Still required: disconnect network, restart services/browser and perform real-camera acceptance.")
