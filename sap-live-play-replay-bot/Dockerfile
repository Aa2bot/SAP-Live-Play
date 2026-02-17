FROM mcr.microsoft.com/playwright:jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx playwright install chromium

CMD ["npm", "start"]
