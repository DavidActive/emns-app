# One image runs everything: the web app + functions server, the scheduler, and the one-off database jobs.
#   docker build -t emns .
#   app:        node server/main.cjs        (default)
#   scheduler:  node server/worker.cjs
#   database:   node scripts/db-local.cjs bootstrap|migrate|seed
FROM node:22-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/dist ./dist
COPY netlify/functions ./netlify/functions
COPY src/server ./src/server
COPY server ./server
COPY scripts ./scripts
COPY docker ./docker
COPY supabase/migrations ./supabase/migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.cjs"]
