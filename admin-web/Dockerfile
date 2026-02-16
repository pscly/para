FROM node:20-alpine AS build

WORKDIR /app

COPY admin-web/package.json admin-web/package-lock.json ./
RUN npm ci

COPY admin-web/index.html ./index.html
COPY admin-web/vite.config.ts ./vite.config.ts
COPY admin-web/tsconfig.app.json ./tsconfig.app.json
COPY admin-web/tsconfig.json ./tsconfig.json
COPY admin-web/tsconfig.node.json ./tsconfig.node.json
COPY admin-web/src ./src
COPY admin-web/public ./public

RUN npm run build

FROM nginx:1.27-alpine

COPY admin-web/nginx.default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
