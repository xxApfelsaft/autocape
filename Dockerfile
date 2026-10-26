FROM node:22-bookworm-slim

WORKDIR /app

# System dependencies for node-gyp / native modules if needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Ensure results and uploads directories exist
RUN mkdir -p /app/results /app/uploads

EXPOSE 3000

CMD ["npm", "start"]
