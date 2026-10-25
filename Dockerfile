# Use official Playwright image with browsers pre-installed
# Pinned by digest (security review EXT-30): a retagged upstream image cannot change the test
# environment unnoticed. The tag must match the @playwright/test version in package.json.
FROM mcr.microsoft.com/playwright:v1.58.2-jammy@sha256:4698a73749c5848d3f5fcd42a2174d172fcad2b2283e087843b115424303a565

# Install Xvfb for virtual display (needed for headed browser/extension testing)
RUN apt-get update && apt-get install -y \
    xvfb \
    x11-utils \
    libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy test files and built extension
COPY . .

# Make entrypoint executable
RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npx", "playwright", "test"]
