FROM node:22-bookworm-slim

# Werkzeuge fuer Dateiarbeit und Medien. Bewusst OHNE Netz zur Laufzeit:
# alles, was Kai-Code braucht, ist hier vorinstalliert.
# - python3 + Bibliotheken: PDF, Word, Excel, Bilder, Daten
# - ffmpeg: Audio/Video; imagemagick: Bilder; zip/unzip, poppler: PDF-Text
# - Schriften: fuer Dokumente und Bilder, die Kais Code erzeugt
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg imagemagick zip unzip poppler-utils \
      ca-certificates curl \
      fonts-liberation fonts-noto-color-emoji fonts-noto-core \
      fonts-dejavu-core fontconfig \
 && pip3 install --no-cache-dir --break-system-packages \
      pypdf pdfplumber python-docx openpyxl Pillow pandas reportlab \
 && fc-cache -f \
 && apt-get purge -y python3-pip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.cache

# Node-Werkzeuge im globalen Pfad, damit Kai-Code sie nutzen kann.
RUN npm install -g --omit=dev sharp@0.35.4 && npm cache clean --force
ENV NODE_PATH=/usr/local/lib/node_modules

ENV SANDBOX_DIR=/sandbox \
    TZ=Europe/Berlin \
    XDG_CACHE_HOME=/tmp/cache

WORKDIR /app
COPY worker.mjs ./
USER node
CMD ["node", "worker.mjs"]
