# Build stage: install all dependencies and compile TypeScript.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependencies only.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Final image: ingest needs pdftoppm/pdftotext (poppler-utils) and python3.
FROM node:22-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY extraction/prepare_input.py extraction/final_prompt.txt ./extraction/
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
