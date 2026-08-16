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

COPY sandbox_extension /opt/jinn/sandbox_extension
RUN python -m pip install --no-deps --no-build-isolation /opt/jinn/sandbox_extension \
    && rm -rf /opt/jinn/sandbox_extension/build /opt/jinn/sandbox_extension/*.egg-info

WORKDIR /jinn/work
COPY --chmod=0555 worker.py /opt/jinn/worker.py
COPY --chmod=0555 binary_judge_worker.py /opt/jinn/binary_judge_worker.py
COPY --chmod=0555 broker.py /opt/jinn/broker.py
COPY --chmod=0555 model_provider.py /opt/jinn/model_provider.py
ENTRYPOINT ["python", "/opt/jinn/worker.py"]
