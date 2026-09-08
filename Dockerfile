FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/scoring/package.json packages/scoring/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci
RUN npx playwright install --with-deps chromium
COPY packages ./packages
COPY apps ./apps
RUN npm run build
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
