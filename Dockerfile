# Use official Playwright image with browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

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
