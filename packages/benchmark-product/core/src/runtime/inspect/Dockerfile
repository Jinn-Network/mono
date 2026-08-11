FROM python:3.11.9-slim-bookworm@sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    PYTHONUTF8=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    TIKTOKEN_CACHE_DIR=/opt/jinn/tiktoken-cache

RUN python -m pip install \
    inspect-ai==0.3.255 \
    inspect-evals==0.16.0 \
    openai==2.53.0 \
    && mkdir -p "${TIKTOKEN_CACHE_DIR}" \
    && python -c 'import tiktoken; tiktoken.get_encoding("o200k_base")' \
    && chmod -R a-w "${TIKTOKEN_CACHE_DIR}"

WORKDIR /jinn/work
COPY --chmod=0555 worker.py /opt/jinn/worker.py
ENTRYPOINT ["python", "/opt/jinn/worker.py"]
