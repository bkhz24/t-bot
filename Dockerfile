FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Install browsers explicitly (belt and suspenders)
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]
