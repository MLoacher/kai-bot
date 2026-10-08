FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    XDG_CACHE_HOME=/tmp/cache \
    ORT_DISABLE_TELEMETRY=1 \
    KAI_DATA_DIR=/data \
    TZ=Europe/Berlin

# ffmpeg zerlegt Videos in Standbilder und Tonspur (src/video.mjs), die
# Schriften braucht bild_zeichnen (src/draw.mjs). Den Schrift-Cache legt der
# Build an, zur Laufzeit ist das Dateisystem schreibgeschuetzt.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fontconfig \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node wuerde sonst CUDA-Bibliotheken nachladen, Kai rechnet auf der CPU.
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Segmentierungsmodelle fuers Freistellen (src/cutout.mjs), mit Pruefsumme.
COPY scripts/models.mjs scripts/patch-baileys.mjs ./scripts/
RUN node scripts/models.mjs /app/models
# Baileys setzt decrypt-fail="hide" nicht bei Umfrage-Stimmen; ohne das zaehlen sie nicht.
RUN node scripts/patch-baileys.mjs
COPY src ./src
COPY vorlagen ./vorlagen

# Laeuft nie als root. Der Benutzer "node" (UID 1000) bringt das Image mit.
USER node
CMD ["node", "src/main.mjs"]
