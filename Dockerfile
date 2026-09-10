# Solo el SERVIDOR va en contenedor. La extension corre dentro del Chrome del usuario, con sus
# sesiones ya iniciadas, y no se puede (ni conviene) contenerizar.
FROM node:24-alpine AS deps
WORKDIR /app

# Copiar solo los manifiestos primero aprovecha la cache de capas: las dependencias solo se
# reinstalan cuando cambian los package.json, no en cada cambio de codigo.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/extension/package.json ./packages/extension/

# El workspace de la extension se declara pero no se instala: vite y crxjs no pintan nada aqui.
RUN npm ci --ignore-scripts --workspace @webbot/shared --workspace @webbot/server --include-workspace-root

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY tsconfig.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# Dentro del contenedor el puente escucha en todas las interfaces; docker-compose lo publica solo
# en 127.0.0.1 del host, asi que sigue sin quedar expuesto a la red local.
ENV WEBBOT_BRIDGE_HOST=0.0.0.0 \
    WEBBOT_BRIDGE_PORT=8790 \
    WEBBOT_HTTP_PORT=8791

USER node
EXPOSE 8790 8791

CMD ["npx", "tsx", "packages/server/src/http.ts"]
