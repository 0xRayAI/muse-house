FROM node:24.22.1-bookworm-slim
# Node 24.22.3 is the patched release. Docker Hub has no node:24.22.3 tag yet.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) narch=x64 ;; arm64) narch=arm64 ;; *) echo "unsupported $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v24.22.3/SHASUMS256.txt" -o /tmp/SHASUMS256.txt \
 && curl -fsSL "https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-${narch}.tar.gz" -o "/tmp/node-v24.22.3-linux-${narch}.tar.gz" \
 && grep " node-v24.22.3-linux-${narch}.tar.gz$" /tmp/SHASUMS256.txt > /tmp/node-sum.txt \
 && (cd /tmp && sha256sum -c node-sum.txt) \
 && tar -xzf "/tmp/node-v24.22.3-linux-${narch}.tar.gz" -C /usr/local --strip-components=1 \
 && rm -f /tmp/SHASUMS256.txt /tmp/node-sum.txt "/tmp/node-v24.22.3-linux-${narch}.tar.gz" \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && node -v | grep -qx v24.22.3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN node scripts/build-data.mjs
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.mjs"]