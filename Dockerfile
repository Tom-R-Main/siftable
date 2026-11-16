FROM node:22.23.3-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json ./
COPY packages ./packages
COPY apps ./apps
COPY modules ./modules
COPY scripts/copy-modules.mjs ./scripts/copy-modules.mjs
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
FROM node:22.23.3-alpine
RUN apk add --no-cache postgresql17-client su-exec
WORKDIR /app
COPY scripts/admin.sh ./scripts/admin.sh
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
ENV SIFT_HOST=0.0.0.0 PORT=8080
CMD ["node","apps/server/dist/index.js"]
