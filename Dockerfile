FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app code
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "index.js"]
