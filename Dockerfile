FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN node scripts/build-data.mjs
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.mjs"]