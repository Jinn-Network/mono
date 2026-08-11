#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Build (and optionally push) a digest-pinned swe-rebench-v2 grader image for ONE instance,
# implementing the `jinn.grader-context.v1` contract (issue #2543).
#
# The grader image is built FROM the instance's own published eval image and bakes in that
# instance's grading parameters (transitions + gold test patch), because the shipped context
# schema does not convey them (see README.md).
#
# Usage:
#   build-grader-image.sh --row <row.json> --tag <ref> [--push] [--platform linux/amd64]
#
#   --row       An swe-rebench HF row JSON with at least:
#                 { instance_id, image_name, FAIL_TO_PASS[], PASS_TO_PASS[], test_patch }
#               (the fields hf-fetcher.ts / the HF datasets-server return).
#   --tag       The grader image ref to build, e.g. localhost:5001/jinn-swe-grader-<instance>:v1
#   --push      Push after building, so `docker` reports a real registry repo-digest — the
#               only form `containerGraderReportSource` accepts (it refuses an unpinned image).
#   --platform  Defaults to linux/amd64 (swe-rebench eval images are x86_64-only).
#
# On success prints the built ref and, when pushed, the `repo@sha256:<digest>` reference to
# put in an EvaluationSpec's familyBlock.image.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROW="" ; TAG="" ; PUSH=0 ; PLATFORM="linux/amd64"
while [ $# -gt 0 ]; do
  case "$1" in
    --row) ROW="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --push) PUSH=1; shift ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ROW" ] && [ -n "$TAG" ] || { echo "--row and --tag are required" >&2; exit 2; }
[ -f "$ROW" ] || { echo "row file not found: $ROW" >&2; exit 2; }

# Resolve the instance eval image to a digest pin so the grader image transitively pins it.
INSTANCE_IMAGE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image_name"])' "$ROW")"
echo "[build] pulling instance image $INSTANCE_IMAGE ($PLATFORM)" >&2
if ! docker pull --platform "$PLATFORM" "$INSTANCE_IMAGE" >&2; then
  # Tolerate a transient registry error when the image is already present locally.
  if docker image inspect "$INSTANCE_IMAGE" >/dev/null 2>&1; then
    echo "[build] pull failed but image is already present locally — continuing" >&2
  else
    echo "[build] pull failed and image is not present locally" >&2; exit 1
  fi
fi
INSTANCE_DIGEST="$(docker image inspect "$INSTANCE_IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"
INSTANCE_PIN="${INSTANCE_DIGEST:-$INSTANCE_IMAGE}"
echo "[build] instance pin: $INSTANCE_PIN" >&2

# Assemble the build context: grade.py (this dir) + baked manifest.json + test.patch.
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
cp "$HERE/grade.py" "$HERE/Dockerfile" "$CTX/"
python3 - "$ROW" "$CTX" <<'PY'
import json, sys
row = json.load(open(sys.argv[1])); ctx = sys.argv[2]
manifest = {
    "instance_id": row["instance_id"],
    "fail_to_pass": row.get("FAIL_TO_PASS", []),
    "pass_to_pass": row.get("PASS_TO_PASS", []),
    "repo_dir": "/testbed",
}
open(f"{ctx}/manifest.json", "w").write(json.dumps(manifest, indent=2))
tp = row["test_patch"]
open(f"{ctx}/test.patch", "w").write(tp if tp.endswith("\n") else tp + "\n")
print(f"[build] baked manifest for {manifest['instance_id']}: "
      f"{len(manifest['fail_to_pass'])} fail-to-pass, {len(manifest['pass_to_pass'])} pass-to-pass",
      file=sys.stderr)
PY

echo "[build] docker build -> $TAG" >&2
docker build --platform "$PLATFORM" --build-arg "INSTANCE_IMAGE=$INSTANCE_PIN" -t "$TAG" "$CTX" >&2

if [ "$PUSH" -eq 1 ]; then
  echo "[build] pushing $TAG" >&2
  docker push "$TAG" >&2
  # Strip only the trailing `:tag` (shortest suffix) so a registry-port colon survives.
  REPO="${TAG%:*}"
  DIGEST="$(docker image inspect "$TAG" --format '{{range .RepoDigests}}{{println .}}{{end}}' \
            | grep -F "$REPO@" | head -1 | sed 's/.*@/@/')"
  echo "[build] grader image digest reference:" >&2
  echo "${REPO}${DIGEST}"
else
  echo "[build] built (not pushed; no repo-digest). Ref: $TAG" >&2
  echo "$TAG"
fi
