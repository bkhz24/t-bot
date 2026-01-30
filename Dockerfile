FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]
