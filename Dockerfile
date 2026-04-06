FROM node:20
RUN apt-get update && apt-get install -y \
  ffmpeg \
  fonts-noto-core \
  fonts-noto-cjk \
  fonts-noto-color-emoji \
  fontconfig \
  && fc-cache -fv \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
