FROM node:20-bookworm-slim AS build

WORKDIR /app/packages/claim-relayer
COPY packages/claim-relayer/package.json packages/claim-relayer/yarn.lock ./
RUN corepack enable && yarn install --immutable
COPY packages/claim-relayer/tsconfig.json packages/claim-relayer/vitest.config.ts ./
COPY packages/claim-relayer/src ./src
RUN yarn build

FROM node:20-bookworm-slim

WORKDIR /app/packages/claim-relayer
ENV NODE_ENV=production
COPY packages/claim-relayer/package.json packages/claim-relayer/yarn.lock ./
RUN corepack enable && yarn install --immutable
COPY --from=build /app/packages/claim-relayer/dist ./dist
COPY client/deployments /app/client/deployments
EXPOSE 8737
CMD ["node", "dist/index.js"]
