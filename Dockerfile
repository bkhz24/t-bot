FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Force browser install inside the container
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]
