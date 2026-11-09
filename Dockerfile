FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && node -e "require.resolve('express')"

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
