FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL="file:/data/prod.sqlite"

RUN mkdir -p /data

COPY package.json package-lock.json* ./
COPY extensions/personalizacion-pagos/package.json ./extensions/personalizacion-pagos/

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npx prisma generate && npm run build

CMD ["npm", "run", "docker-start"]
