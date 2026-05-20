FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save typescript tsx

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
