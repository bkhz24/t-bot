FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

# Force Playwright to use the browsers included in the image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]
