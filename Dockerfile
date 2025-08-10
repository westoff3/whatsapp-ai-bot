# Node 18 + Debian Bullseye (stabil)
FROM node:18-bullseye

# Chromium ve gerekli kütüphaneler
RUN apt-get update && apt-get install -y \
    chromium ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libfontconfig1 libgdk-pixbuf2.0-0 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 \
    libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
    libxrender1 libxkbcommon0 libxshmfence1 libxss1 libgbm1 libdrm2 \
  && rm -rf /var/lib/apt/lists/*

# Puppeteer kendi Chrome'unu indirmesin; sistemdeki Chromium'u kullansın
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium

# Uygulama dizini
WORKDIR /app

# Önce package dosyaları (cache-friendly)
COPY package*.json ./

# Prod bağımlılıklarını kur
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps

# Uygulama kodu
COPY . .

# Uygulamayı başlat
CMD ["npm", "start"]
