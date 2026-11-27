# Lấy Node 24 cho server và trình tải YouTube, rồi dùng Python 3.12 để phân tích.
FROM node:24-bookworm-slim AS node_runtime
FROM python:3.12-slim-bookworm
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV PYTHONUNBUFFERED=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 NUMBA_NUM_THREADS=1
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY analysis/requirements.txt analysis/requirements.txt
RUN pip install --no-cache-dir -r analysis/requirements.txt
RUN useradd --system --create-home orbit && mkdir /app/.cache && chown orbit /app/.cache
COPY package.json server.mjs ./
COPY server/ server/
COPY analysis/ analysis/
COPY public/ public/
USER orbit
CMD ["node", "server.mjs"]
