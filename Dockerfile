FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @ponswarp/core build && pnpm --filter @ponswarp/signaling build

FROM node:24-alpine AS signaling
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY --from=build /app/packages/signaling/dist ./packages/signaling/dist
COPY --from=build /app/packages/signaling/package.json ./packages/signaling/package.json
EXPOSE 8787
CMD ["node", "packages/signaling/dist/cli.js"]
