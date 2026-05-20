FROM node:20-bookworm-slim AS build

WORKDIR /app
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --immutable
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN yarn build

FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --immutable
COPY --from=build /app/dist ./dist
EXPOSE 8737
CMD ["node", "dist/index.js"]
