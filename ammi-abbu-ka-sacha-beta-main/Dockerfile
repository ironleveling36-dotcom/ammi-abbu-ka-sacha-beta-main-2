FROM node:20-bookworm-slim

# Install Chromium + dependencies for WAF token generation
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create data directory for persistent storage (accounts, WAF token, vault)
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production \
    SIMPLE_CHAT_MODE=1 \
    HEADLESS=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_OPTIONS="--dns-result-order=ipv4first --max-old-space-size=512"

WORKDIR /usr/src/app

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY . .

# Ensure data directory is writable
RUN chown -R node:node /app/data

USER node

CMD ["npm", "start"]