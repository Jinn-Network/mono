# SPDX-License-Identifier: Apache-2.0
#
# swe-rebench-v2 grader image — implements the `jinn.grader-context.v1` container contract
# (issue #2543). Built PER INSTANCE, FROM that instance's published swe-rebench eval image,
# so the checked-out repository (/testbed) and its ready pytest environment come from the
# base image and the jinn grading logic is layered on top.
#
# The instance's grading parameters are baked in at build time because the shipped
# `jinn.grader-context.v1` context file does not convey them (see grade.py's header and the
# README). `build-grader-image.sh` writes `manifest.json` + `test.patch` into the build
# context before invoking this Dockerfile.
#
#   docker build --platform linux/amd64 \
#     --build-arg INSTANCE_IMAGE=swerebench/sweb.eval.x86_64.<instance>@sha256:<digest> \
#     -t <registry>/<repo>:<tag> .
#
# INSTANCE_IMAGE SHOULD be digest-pinned so the grader image transitively pins the exact
# instance environment it grades.
ARG INSTANCE_IMAGE
FROM ${INSTANCE_IMAGE}

# The jinn grading logic + this instance's baked parameters. `grade.py` is pure-stdlib and
# runs under the instance image's own python (on PATH via the testbed conda env).
COPY grade.py /jinn/grader/grade.py
COPY manifest.json /jinn/grader/manifest.json
COPY test.patch /jinn/grader/test.patch

# The M4c driver sets the working directory to the bound mount target at run time
# (`--workdir`), where the package leaves `evaluation-context.json` and `subject/`. grade.py
# resolves that from its cwd, so no WORKDIR is pinned here. The base image keeps its own ENV
# (PATH into the testbed env), which is how `python3`/`pytest` resolve.
ENTRYPOINT ["python3", "/jinn/grader/grade.py"]
