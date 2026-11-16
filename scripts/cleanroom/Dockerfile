FROM node:22.23.3-alpine AS node
FROM docker:29.9.3-dind
RUN apk add --no-cache libstdc++
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN adduser -D -u 10001 newcomer && mkdir /workspace && chown 10001:10001 /workspace
WORKDIR /workspace
ENTRYPOINT ["dockerd"]
CMD ["--host=unix:///var/run/docker.sock"]
