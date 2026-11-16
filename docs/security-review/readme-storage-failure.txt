$ git rev-parse HEAD
c915c694d9807ef334faece556d02e4b8fdedd54

$ git archive --format=tar --output=/Users/thomasmain/projects/siftable/.local/readme-71dbb012/source.tar c915c694d9807ef334faece556d02e4b8fdedd54

$ tar -xf /Users/thomasmain/projects/siftable/.local/readme-71dbb012/source.tar -C /Users/thomasmain/projects/siftable/.local/readme-71dbb012/harness scripts/cleanroom/Dockerfile

$ docker build -t siftable-readme-runner:71dbb012 /Users/thomasmain/projects/siftable/.local/readme-71dbb012/harness/scripts/cleanroom
#0 building with "desktop-linux" instance using docker driver

#1 [internal] load build definition from Dockerfile
#1 transferring dockerfile: 572B done
#1 DONE 0.0s

#2 [internal] load metadata for docker.io/library/node:22.23.3-alpine
#2 DONE 0.0s

#3 [internal] load metadata for docker.io/library/docker:29.9.3-dind
#3 DONE 0.8s

#4 [internal] load .dockerignore
#4 transferring context: 2B done
#4 DONE 0.0s

#5 [node 1/1] FROM docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
#5 resolve docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 0.0s done
#5 DONE 0.0s

#6 [stage-1 1/7] FROM docker.io/library/docker:29.9.3-dind@sha256:7bf70dcb85c822e3fa6f2d332143e474b99147b9d7b39102b0cfe8b04a7dd61b
#6 resolve docker.io/library/docker:29.9.3-dind@sha256:7bf70dcb85c822e3fa6f2d332143e474b99147b9d7b39102b0cfe8b04a7dd61b 0.0s done
#6 DONE 0.0s

#7 [stage-1 4/7] COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
#7 CACHED

#8 [stage-1 6/7] RUN adduser -D -u 10001 newcomer && mkdir /workspace && chown 10001:10001 /workspace
#8 CACHED

#9 [stage-1 3/7] COPY --from=node /usr/local/bin/node /usr/local/bin/node
#9 CACHED

#10 [stage-1 2/7] RUN apk add --no-cache libstdc++
#10 CACHED

#11 [stage-1 5/7] RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
#11 CACHED

#12 [stage-1 7/7] WORKDIR /workspace
#12 CACHED

#13 exporting to image
#13 exporting layers done
#13 exporting manifest sha256:93eb4177d60a46201c6b574def063d4ecdd28cf99318ef64e2bd85047312798f done
#13 exporting config sha256:4050570edd4ee177cedf39f6b21454f71bc0087cfc572d194505e012322d40ba done
#13 exporting attestation manifest sha256:9f9950194b7866ec8f0b07484197a5c65865d82e43ed19c079b1bce1c6096210 0.0s done
#13 exporting manifest list sha256:1dc1ba12073e28746c6e4af759ec340d5d7b624d8b43e0a6f745f821bd3da0d8 0.0s done
#13 naming to docker.io/library/siftable-readme-runner:71dbb012 done
#13 unpacking to docker.io/library/siftable-readme-runner:71dbb012
#13 unpacking to docker.io/library/siftable-readme-runner:71dbb012 4.9s done
#13 DONE 5.0s

$ docker run -d --privileged --name sift-readme-71dbb012 siftable-readme-runner:71dbb012
9d8a102288473dfe57e9362ea63d715e1fb024a198bad555dd05533f3638da76

$ docker cp /Users/thomasmain/projects/siftable/.local/readme-71dbb012/source.tar sift-readme-71dbb012:/tmp/source.tar

$ docker exec sift-readme-71dbb012 sh -ec for i in $(seq 1 60); do if docker info >/dev/null 2>&1; then chown root:10001 /var/run/docker.sock; chmod 660 /var/run/docker.sock; exit 0; fi; sleep 1; done; exit 1

$ docker exec --user 10001:10001 -e HOME=/home/newcomer sift-readme-71dbb012 tar -xf /tmp/source.tar

$ docker exec --user 10001:10001 -e HOME=/home/newcomer sift-readme-71dbb012 node scripts/cleanroom/verify.mjs
RUN docker info --format {{json .}}
RUN docker volume ls -q
RUN docker compose version --short
5.7.1
PASS fresh non-root home, npm, application, Docker image/container/volume state
RUN npm ci

added 130 packages, and audited 137 packages in 2s

37 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
npm notice
npm notice New major version of npm available! 10.9.9 -> 12.2.2
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.2
npm notice To update run: npm install -g npm@12.2.2
npm notice
RUN npm run build

> siftable-headless@0.1.0 build
> tsc -b && node scripts/copy-modules.mjs

PASS missing configuration fails before bootstrap
RUN npm run local

> siftable-headless@0.1.0 local
> node scripts/local.mjs

#1 [internal] load local bake definitions
#1 reading from stdin 491B done
#1 DONE 0.0s

#2 [internal] load build definition from Dockerfile
#2 transferring dockerfile:
#2 transferring dockerfile: 731B done
#2 DONE 0.0s

#3 [internal] load metadata for docker.io/library/node:22.23.3-alpine
#3 DONE 1.7s

#4 [internal] load .dockerignore
#4 transferring context:
#4 transferring context: 107B done
#4 DONE 0.2s

#5 [build 1/8] FROM docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
#5 resolve docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 0.0s done
#5 ...

#6 [internal] load build context
#6 transferring context: 207.93kB 0.0s done
#6 DONE 0.3s

#5 [build 1/8] FROM docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
#5 sha256:66fa63c7a061939c4346f9c3c1ada45434b276dd4e4274721d6bf13cb8adec6e 0B / 444B 0.2s
#5 sha256:66fa63c7a061939c4346f9c3c1ada45434b276dd4e4274721d6bf13cb8adec6e 444B / 444B 0.2s done
#5 sha256:74849c662da757b89cfe8b5406d7beaaf491727ea6843cbba85b8889d1543956 0B / 1.26MB 0.3s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 0B / 55.60MB 0.2s
#5 sha256:a9986cd6f37dbddae7862a6d4be71683472e7c2ea708e87db14f8a6393c00f00 0B / 4.19MB 0.2s
#5 sha256:74849c662da757b89cfe8b5406d7beaaf491727ea6843cbba85b8889d1543956 1.26MB / 1.26MB 0.6s done
#5 sha256:a9986cd6f37dbddae7862a6d4be71683472e7c2ea708e87db14f8a6393c00f00 2.10MB / 4.19MB 0.9s
#5 sha256:a9986cd6f37dbddae7862a6d4be71683472e7c2ea708e87db14f8a6393c00f00 4.19MB / 4.19MB 1.1s done
#5 extracting sha256:a9986cd6f37dbddae7862a6d4be71683472e7c2ea708e87db14f8a6393c00f00 0.1s done
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 3.15MB / 55.60MB 2.0s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 6.29MB / 55.60MB 2.7s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 10.49MB / 55.60MB 3.2s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 14.68MB / 55.60MB 3.6s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 18.87MB / 55.60MB 3.9s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 24.12MB / 55.60MB 4.2s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 29.36MB / 55.60MB 4.5s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 33.55MB / 55.60MB 4.7s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 39.85MB / 55.60MB 5.0s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 45.09MB / 55.60MB 5.1s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 50.33MB / 55.60MB 5.3s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 54.53MB / 55.60MB 5.4s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 55.60MB / 55.60MB 8.0s done
#5 extracting sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9
#5 extracting sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 0.9s done
#5 DONE 9.4s

#5 [build 1/8] FROM docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
#5 extracting sha256:74849c662da757b89cfe8b5406d7beaaf491727ea6843cbba85b8889d1543956
#5 extracting sha256:74849c662da757b89cfe8b5406d7beaaf491727ea6843cbba85b8889d1543956 1.4s done
#5 DONE 10.8s

#5 [build 1/8] FROM docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
#5 extracting sha256:66fa63c7a061939c4346f9c3c1ada45434b276dd4e4274721d6bf13cb8adec6e 0.0s done
#5 DONE 10.9s

#7 [build 2/8] WORKDIR /app
#7 DONE 3.5s

#8 [stage-1 2/8] RUN apk add --no-cache postgresql17-client su-exec
#8 ...

#9 [build 3/8] COPY package.json package-lock.json tsconfig*.json ./
#9 DONE 0.1s

#10 [build 4/8] COPY packages ./packages
#10 DONE 0.1s

#11 [build 5/8] COPY apps ./apps
#11 DONE 0.0s

#12 [build 6/8] COPY modules ./modules
#12 DONE 0.0s

#13 [build 7/8] COPY scripts/copy-modules.mjs ./scripts/copy-modules.mjs
#13 DONE 0.0s

#14 [build 8/8] RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
#14 ...

#8 [stage-1 2/8] RUN apk add --no-cache postgresql17-client su-exec
#8 4.541 (1/9) Installing postgresql-common (1.3-r0)
#8 4.571   Executing postgresql-common-1.3-r0.pre-install
#8 4.632 (2/9) Installing lz4-libs (1.10.0-r1)
#8 4.663 (3/9) Installing libpq (18.7-r0)
#8 4.693 (4/9) Installing ncurses-terminfo-base (6.6_p20260516-r0)
#8 4.725 (5/9) Installing libncursesw (6.6_p20260516-r0)
#8 4.757 (6/9) Installing readline (8.3.3-r1)
#8 4.868 (7/9) Installing zstd-libs (1.5.7-r2)
#8 4.909 (8/9) Installing postgresql17-client (17.12-r0)
#8 5.050 (9/9) Installing su-exec (0.3-r0)
#8 5.077 Executing busybox-1.37.0-r31.trigger
#8 5.088 Executing postgresql-common-1.3-r0.trigger
#8 5.090 * Setting postgresql17 as the default version
#8 5.136 * find: /usr/share/man: No such file or directory
#8 5.880 *
#8 5.880 * You are using 'postgresql17'. It's recommended to upgrade to the latest
#8 5.880 * major version provided by package 'postgresql18'.
#8 5.880 * Use command 'pg_versions' to switch between versions.
#8 5.880 *
#8 5.882 OK: 16.7 MiB in 27 packages
#8 DONE 6.9s

#14 [build 8/8] RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
#14 3.253
#14 3.253 added 130 packages, and audited 137 packages in 3s
#14 3.253
#14 3.253 37 packages are looking for funding
#14 3.253   run `npm fund` for details
#14 3.253
#14 3.253 found 0 vulnerabilities
#14 3.253 npm notice
#14 3.253 npm notice New major version of npm available! 10.9.9 -> 12.2.2
#14 3.253 npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.2
#14 3.253 npm notice To update run: npm install -g npm@12.2.2
#14 3.253 npm notice
#14 3.383
#14 3.383 > siftable-headless@0.1.0 build
#14 3.383 > tsc -b && node scripts/copy-modules.mjs
#14 3.383
#14 4.298
#14 4.298 changed 2 packages, and audited 122 packages in 533ms
#14 4.298
#14 4.298 36 packages are looking for funding
#14 4.298   run `npm fund` for details
#14 4.299
#14 4.299 found 0 vulnerabilities
#14 ...

#15 [stage-1 3/8] WORKDIR /app
#15 DONE 3.4s

#14 [build 8/8] RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
#14 DONE 6.5s

#16 [stage-1 4/8] COPY scripts/admin.sh ./scripts/admin.sh
#16 DONE 0.1s

#17 [stage-1 5/8] COPY --from=build /app/node_modules ./node_modules
#17 DONE 1.1s

#18 [stage-1 6/8] COPY --from=build /app/package.json ./package.json
#18 DONE 0.1s

#19 [stage-1 7/8] COPY --from=build /app/packages ./packages
#19 DONE 0.1s

#20 [stage-1 8/8] COPY --from=build /app/apps ./apps
#20 DONE 0.1s

#21 exporting to image
#21 exporting layers
#21 exporting layers 0.7s done
#21 exporting manifest sha256:31e68a8b4b27d5bfdca31da6f41f1735038667c0387f2279b854c1be1833e62c done
#21 exporting config sha256:5b20622ffe01a3bdf069333ecff6147b0487ca91c9e11fd1b82146bf736a81a7 done
#21 exporting attestation manifest sha256:3e1fd444321892d3fb8f5340e38e009678b362576de5f1bef3aaeb71e452b17d 0.0s done
#21 exporting manifest list sha256:b2763a1c2aa3f6857e6832672facbdcf86d8b4686fae22dca86687d4fc909c61 done
#21 naming to docker.io/library/siftable-headless:local done
#21 unpacking to docker.io/library/siftable-headless:local
#21 unpacking to docker.io/library/siftable-headless:local 1.6s done
#21 DONE 2.3s

#22 resolving provenance for metadata file
#22 DONE 0.0s
{
  "principalId": "f17fd7f7-3e0b-4680-aff2-0ac6adde410f",
  "ownerId": "09ac3736-0dc8-4624-96db-4b9720cd8bd6",
  "scopeId": null,
  "credentialFile": "/run/sift/owner.json"
}
{"status":"ready","url":"http://127.0.0.1:8088","credentialFile":".local/owner.json","modules":"projects,context,work,planning,extensions"}
 Image siftable-headless:local Building
 Image siftable-headless:local Built
 Image pgvector/pgvector:pg17 Pulling
 ef0b9aca4fbb Pulling fs layer 0B
 124c0425e69b Pulling fs layer 0B
 2d66c782e484 Pulling fs layer 0B
 605893accf60 Pulling fs layer 0B
 668cd6ea902f Pulling fs layer 0B
 7c4e3c588c24 Pulling fs layer 0B
 db2b2896d2ea Pulling fs layer 0B
 8546da52b30b Pulling fs layer 0B
 349ba3c66c14 Pulling fs layer 0B
 af1c4097986f Pulling fs layer 0B
 6fcdae2679cf Pulling fs layer 0B
 2cb63c71a9bf Pulling fs layer 0B
 502716bb0323 Pulling fs layer 0B
 f4c7aa638871 Pulling fs layer 0B
 03ad3f411681 Pulling fs layer 0B
 c879a6d9e752 Pulling fs layer 0B
 124c0425e69b Download complete 0B
 ef0b9aca4fbb Downloading 1.049MB
 ef0b9aca4fbb Download complete 0B
 605893accf60 Download complete 0B
 2d66c782e484 Downloading 2.097MB
 668cd6ea902f Downloading 2.097MB
 668cd6ea902f Downloading 4.519MB
 2d66c782e484 Downloading 5.243MB
 2d66c782e484 Downloading 8.389MB
 db2b2896d2ea Downloading 1.049MB
 2d66c782e484 Downloading 8.389MB
 668cd6ea902f Download complete 0B
 db2b2896d2ea Downloading 2.097MB
 2d66c782e484 Downloading 10.49MB
 7c4e3c588c24 Downloading 1.049MB
 db2b2896d2ea Downloading 4.194MB
 2d66c782e484 Downloading 13.63MB
 7c4e3c588c24 Download complete 0B
 2d66c782e484 Downloading 17.83MB
 db2b2896d2ea Downloading 5.243MB
 db2b2896d2ea Downloading 7.34MB
 2d66c782e484 Downloading 22.02MB
 2d66c782e484 Downloading 23.07MB
 db2b2896d2ea Downloading 8.066MB
 8546da52b30b Downloading 1.109MB
 2d66c782e484 Downloading 26.21MB
 2d66c782e484 Downloading 28.14MB
 349ba3c66c14 Downloading 116B
 af1c4097986f Downloading 170B
 2cb63c71a9bf Downloading 10.36kB
 db2b2896d2ea Download complete 0B
 8546da52b30b Downloading 1.109MB
 349ba3c66c14 Downloading 116B
 af1c4097986f Downloading 170B
 2cb63c71a9bf Downloading 10.36kB
 8546da52b30b Downloading 1.109MB
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 03ad3f411681 Downloading 132.9kB
 2d66c782e484 Downloading 28.14MB
 349ba3c66c14 Downloading 116B
 502716bb0323 Downloading 186B
 c879a6d9e752 Downloading 129B
 721f8a2a085c Downloading 2.037kB
 f4c7aa638871 Downloading 6.11kB
 af1c4097986f Downloading 170B
 6fcdae2679cf Downloading 17.83MB
 2cb63c71a9bf Downloading 10.36kB
 8546da52b30b Downloading 1.109MB
 03ad3f411681 Downloading 132.9kB
 2d66c782e484 Downloading 28.14MB
 349ba3c66c14 Downloading 116B
 502716bb0323 Downloading 186B
 c879a6d9e752 Downloading 129B
 721f8a2a085c Downloading 2.037kB
 f4c7aa638871 Downloading 6.11kB
 af1c4097986f Downloading 170B
 6fcdae2679cf Downloading 18.87MB
 2cb63c71a9bf Downloading 10.36kB
 f4c7aa638871 Download complete 0B
 af1c4097986f Download complete 0B
 6fcdae2679cf Downloading 32.51MB
 2cb63c71a9bf Download complete 0B
 8546da52b30b Download complete 0B
 03ad3f411681 Download complete 0B
 2d66c782e484 Download complete 0B
 349ba3c66c14 Download complete 0B
 502716bb0323 Downloading 186B
 c879a6d9e752 Download complete 0B
 721f8a2a085c Download complete 0B
 2d66c782e484 Extracting 1B
 502716bb0323 Download complete 0B
 6fcdae2679cf Downloading 36.7MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 37.75MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 41.94MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 47.19MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 52.43MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 57.67MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 58.72MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 62.91MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 68.16MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 73.4MB
 2d66c782e484 Extracting 1B
 6fcdae2679cf Downloading 76.55MB
 2d66c782e484 Extracting 2B
 6fcdae2679cf Downloading 80.74MB
 2d66c782e484 Extracting 2B
 6fcdae2679cf Downloading 82.84MB
 2d66c782e484 Extracting 2B
 6fcdae2679cf Downloading 110.1MB
 6fcdae2679cf Downloading 112.2MB
 2d66c782e484 Pull complete 0B
 6fcdae2679cf Downloading 117.4MB
 605893accf60 Pull complete 0B
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Downloading 117.4MB
 6fcdae2679cf Download complete 0B
 668cd6ea902f Extracting 1B
 668cd6ea902f Pull complete 0B
 7c4e3c588c24 Pull complete 0B
 db2b2896d2ea Extracting 1B
 124c0425e69b Extracting 1B
 db2b2896d2ea Pull complete 0B
 8546da52b30b Pull complete 0B
 349ba3c66c14 Pull complete 0B
 124c0425e69b Pull complete 0B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 1B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 2B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 3B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 4B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 5B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 6B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 7B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 8B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 9B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 10B
 6fcdae2679cf Extracting 11B
 6fcdae2679cf Extracting 11B
 6fcdae2679cf Extracting 11B
 6fcdae2679cf Extracting 11B
 2cb63c71a9bf Extracting 1B
 6fcdae2679cf Pull complete 0B
 f4c7aa638871 Pull complete 0B
 af1c4097986f Pull complete 0B
 2cb63c71a9bf Pull complete 0B
 03ad3f411681 Extracting 1B
 c879a6d9e752 Pull complete 0B
 502716bb0323 Pull complete 0B
 ef0b9aca4fbb Pull complete 0B
 03ad3f411681 Pull complete 0B
 Image pgvector/pgvector:pg17 Pulled
 Network siftable-headless_private Creating
 Volume siftable-headless_database Creating
 Volume siftable-headless_database Created
 Network siftable-headless_private Created
 Container siftable-headless-db-1 Creating
 Container siftable-headless-db-1 Created
 Container siftable-headless-db-1 Starting
 Container siftable-headless-db-1 Started
 Container siftable-headless-db-1 Waiting
 Container siftable-headless-db-1 Healthy
 Container siftable-headless-db-1 Running
 Container siftable-headless-db-1 Waiting
 Container siftable-headless-db-1 Healthy
 Container siftable-headless-admin-run-665495c662c3 Creating
 Container siftable-headless-admin-run-665495c662c3 Created
 Container siftable-headless-db-1 Running
 Network siftable-headless_local Creating
 Network siftable-headless_local Created
 Container siftable-headless-server-1 Creating
 Container siftable-headless-server-1 Created
 Container siftable-headless-db-1 Waiting
 Container siftable-headless-db-1 Healthy
 Container siftable-headless-server-1 Starting
 Container siftable-headless-server-1 Started
RUN node packages/cli/dist/index.js catalog --config .local/owner.json --json {}
RUN node packages/cli/dist/index.js config.info --config .local/owner.json --json {}
RUN node packages/cli/dist/index.js modules.list --config .local/owner.json --json {}
RUN node packages/cli/dist/index.js schema.inspect --config .local/owner.json --json {}
PASS README bootstrap and first CLI access with host-owned private credentials
RUN npm run example:first-work

> siftable-headless@0.1.0 example:first-work
> node scripts/first-work.mjs

CLI catalog
CLI config.info
CLI projects.create
CLI notes.create
CLI work.create
CLI work.create
CLI work.claim
MCP work_start
MCP notes_get
MCP context_packet
MCP work_evidence
MCP work_review
CLI work.accept
{
  "runId": "84f3d002-5258-4be6-a83d-fc891ecdf1df",
  "projectId": "309d29e7-4334-499c-8201-bb968895ae60",
  "noteId": "64b94ac4-4479-42a5-8bc6-29f2cef56cb4",
  "workId": "cdd74de2-915b-4f26-8f7c-a181aa5f3aa0",
  "packetId": "47fbbf95-eca5-4bf3-8bdd-09d682327b3b",
  "status": "done",
  "coverage": "commands_passed",
  "agentAcceptanceRefused": true,
  "credentialRevoked": true
}
PASS CLI create/claim -> actual stdio MCP context/evidence/review -> owner CLI acceptance
RUN docker compose stop
 Container siftable-headless-server-1 Stopping
 Container siftable-headless-server-1 Stopped
 Container siftable-headless-db-1 Stopping
 Container siftable-headless-db-1 Stopped
RUN docker compose start
 Container siftable-headless-db-1 Starting
 Container siftable-headless-db-1 Started
 Container siftable-headless-db-1 Waiting
 Container siftable-headless-db-1 Healthy
 Container siftable-headless-server-1 Starting
 Container siftable-headless-server-1 Error response from daemon: failed to set up container networking: failed to update store for object type *libnetwork.sbState: input/output error
Error response from daemon: failed to set up container networking: failed to update store for object type *libnetwork.sbState: input/output error
file:///workspace/scripts/cleanroom/verify.mjs:17
    throw new Error(`Failed ${command} ${args[0]} (${result.status})`);
          ^

Error: Failed docker compose (1)
    at run (file:///workspace/scripts/cleanroom/verify.mjs:17:11)
    at file:///workspace/scripts/cleanroom/verify.mjs:105:1

Node.js v22.23.3

$ docker rm -fv sift-readme-71dbb012
Error response from daemon: cannot remove container "sift-readme-71dbb012": write /var/lib/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db: read-only file system
