FROM node:24-alpine

WORKDIR /app

# Copy package manifests
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose HTTP & WebSocket port
EXPOSE 3000

# Start the game server
CMD ["node", "server.js"]
