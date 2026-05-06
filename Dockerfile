FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server/ ./server/
COPY public/ ./public/

# Data directory (mount as volume for persistence)
RUN mkdir -p /app/data/outputs

EXPOSE 3200

CMD ["node", "server/index.js"]
