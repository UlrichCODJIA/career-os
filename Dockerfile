FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile --production \
  && mkdir -p /data/artifacts /data/release-evidence \
  && chown -R bun:bun /data/artifacts /data/release-evidence

USER bun

CMD ["bun", "run", "apps/api/src/index.ts"]
