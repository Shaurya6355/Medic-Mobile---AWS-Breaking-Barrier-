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

# All base images are multi-arch (node:22-slim, Debian poppler-utils/python3), so
# `docker buildx build --platform linux/arm64` (AgentCore Runtime) needs no changes.
# Runtime image: ingest needs pdftoppm/pdftotext (poppler-utils) and python3.
FROM node:22-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY extraction/prepare_input.py extraction/final_prompt.txt extraction/fill_prompt.txt ./extraction/
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]

# AWS Lambda (container image): same runtime plus the Lambda Web Adapter extension.
# Build with `--target lambda`. The adapter forwards API Gateway HTTP events as plain
# HTTP to port 8080, checks readiness on GET /ping and forwards non-HTTP events
# (SQS, EventBridge schedule) as POST to the pass-through path.
FROM runtime AS lambda
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/ping \
    AWS_LWA_PASS_THROUGH_PATH=/events \
    AWS_LWA_ERROR_STATUS_CODES=500-599 \
    RUN_MODE=lambda

# Last stage = default target, so a plain `docker build .` yields the container image
# (RUN_MODE defaults to container). Keep this stage last.
FROM runtime AS container
