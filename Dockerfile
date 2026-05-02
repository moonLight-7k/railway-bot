FROM node:24-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

RUN rm -rf src/ tsconfig.json node_modules/
RUN npm ci --omit=dev

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/railwaybot.js"]
