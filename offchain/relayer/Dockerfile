FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Default runs the relayer; the keeper runs via a compose command override.
CMD ["node", "dist/index.js"]
