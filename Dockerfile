FROM mcr.microsoft.com/playwright:v1.55.0-jammy

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 4278

CMD ["node", "./src/studio/server.mjs"]
