FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

# Install deps (works even if package-lock.json is missing)
COPY package.json ./
RUN npm install --omit=dev

# Copy app
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "index.js"]
