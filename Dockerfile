FROM node:20-alpine

WORKDIR /app

# Instalar dependencias (capa cacheable)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

# Carpeta de leads (montar como volumen para persistir)
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
