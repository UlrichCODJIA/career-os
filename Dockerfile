FROM oven/bun:1.3.14-alpine

WORKDIR /app

ARG CAREER_OS_RELEASE_COMMIT=unbound
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile --production \
  && printf '%s\n' "$CAREER_OS_RELEASE_COMMIT" > /app/.release-commit \
  && mkdir -p /data/artifacts /data/release-evidence \
  && chown -R bun:bun /data/artifacts /data/release-evidence

USER bun

CMD ["bun", "run", "apps/api/src/index.ts"]
