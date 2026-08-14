# ---- Build stage ----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first (cached separately from source changes).
COPY package.json package-lock.json ./
RUN npm ci

# `NEXT_PUBLIC_*` values are inlined at build time. The default assumes the
# backend is reachable from the browser at localhost:4000; override with
# --build-arg when the backend runs elsewhere.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_NETWORK=testnet
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_NETWORK=$NEXT_PUBLIC_NETWORK

COPY . .
RUN npm run build

# ---- Runtime stage --------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `next build` with `output: "standalone"` produces a self-contained server.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

USER node
EXPOSE 3000

CMD ["node", "server.js"]
