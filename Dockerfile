FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SRK_DATA_DIR=/data \
    SRK_UPLOAD_DIR=/data/uploads \
    SRK_TRUST_PROXY=1 \
    SECURE_COOKIES=1

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data/uploads /app/storage/uploads

EXPOSE 3000

CMD ["sh", "-c", "node src/seed.mjs && node src/server.mjs"]
