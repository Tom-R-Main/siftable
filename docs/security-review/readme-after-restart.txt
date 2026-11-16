$ git rev-parse HEAD
8a10f258a9da5ed607d317ef526d68f517c35e7b

$ git archive --format=tar --output=/Users/thomasmain/projects/siftable/.local/readme-50548711/source.tar 8a10f258a9da5ed607d317ef526d68f517c35e7b

$ tar -xf /Users/thomasmain/projects/siftable/.local/readme-50548711/source.tar -C /Users/thomasmain/projects/siftable/.local/readme-50548711/harness scripts/cleanroom/Dockerfile

$ docker build -t siftable-readme-runner:50548711 /Users/thomasmain/projects/siftable/.local/readme-50548711/harness/scripts/cleanroom
#0 building with "desktop-linux" instance using docker driver

#1 [internal] load build definition from Dockerfile
#1 transferring dockerfile: 572B done
#1 DONE 0.0s

#2 [internal] load metadata for docker.io/library/node:22.23.3-alpine
#2 DONE 0.1s

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
#6 DONE 0.1s

#7 [stage-1 2/7] RUN apk add --no-cache libstdc++
#7 CACHED

#8 [stage-1 5/7] RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
#8 CACHED

#9 [stage-1 4/7] COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
#9 CACHED

#10 [stage-1 6/7] RUN adduser -D -u 10001 newcomer && mkdir /workspace && chown 10001:10001 /workspace
#10 CACHED

#11 [stage-1 3/7] COPY --from=node /usr/local/bin/node /usr/local/bin/node
#11 CACHED

#12 [stage-1 7/7] WORKDIR /workspace
#12 CACHED

#13 exporting to image
#13 exporting layers done
#13 exporting manifest sha256:93eb4177d60a46201c6b574def063d4ecdd28cf99318ef64e2bd85047312798f 0.0s done
#13 exporting config sha256:4050570edd4ee177cedf39f6b21454f71bc0087cfc572d194505e012322d40ba
#13 exporting config sha256:4050570edd4ee177cedf39f6b21454f71bc0087cfc572d194505e012322d40ba done
#13 exporting attestation manifest sha256:eccea36df0136c6df4a6b905c81dd51c36829f1e0e159c91e8a2596b83ab114e 0.0s done
#13 exporting manifest list sha256:ae36c2587687b898fffd04a3f23318019111f6e56367fd9e1e9e8759b9a1c183 0.0s done
#13 naming to docker.io/library/siftable-readme-runner:50548711 done
#13 unpacking to docker.io/library/siftable-readme-runner:50548711
#13 unpacking to docker.io/library/siftable-readme-runner:50548711 4.8s done
#13 DONE 4.9s

$ docker run -d --privileged --name sift-readme-50548711 siftable-readme-runner:50548711
e62f6a87c98cf9e9789361dffad20bc1474114b650368f113b9f13aaa31ef1c6

$ docker cp /Users/thomasmain/projects/siftable/.local/readme-50548711/source.tar sift-readme-50548711:/tmp/source.tar

$ docker exec sift-readme-50548711 sh -ec for i in $(seq 1 60); do if docker info >/dev/null 2>&1; then chown root:10001 /var/run/docker.sock; chmod 660 /var/run/docker.sock; exit 0; fi; sleep 1; done; exit 1

$ docker exec --user 10001:10001 -e HOME=/home/newcomer sift-readme-50548711 tar -xf /tmp/source.tar

$ docker exec --user 10001:10001 -e HOME=/home/newcomer sift-readme-50548711 node scripts/cleanroom/verify.mjs
RUN docker info --format {{json .}}
RUN docker volume ls -q
RUN docker compose version --short
5.7.1
PASS fresh non-root home, npm, application, Docker image/container/volume state
RUN npm ci

added 130 packages, and audited 137 packages in 1s

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
#3 DONE 1.1s

#4 [internal] load .dockerignore
#4 transferring context: 107B done
#4 DONE 0.0s

#5 [build 1/8] FROM docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
#5 resolve docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 done
#5 ...

#6 [internal] load build context
#6 transferring context: 207.93kB done
#6 DONE 0.1s

#5 [build 1/8] FROM docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
#5 sha256:66fa63c7a061939c4346f9c3c1ada45434b276dd4e4274721d6bf13cb8adec6e 0B / 444B 0.2s
#5 sha256:66fa63c7a061939c4346f9c3c1ada45434b276dd4e4274721d6bf13cb8adec6e 444B / 444B 0.2s done
#5 sha256:74849c662da757b89cfe8b5406d7beaaf491727ea6843cbba85b8889d1543956 0B / 1.26MB 0.3s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 0B / 55.60MB 0.2s
#5 sha256:a9986cd6f37dbddae7862a6d4be71683472e7c2ea708e87db14f8a6393c00f00 0B / 4.19MB 0.2s
#5 sha256:74849c662da757b89cfe8b5406d7beaaf491727ea6843cbba85b8889d1543956 1.26MB / 1.26MB 0.3s done
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 3.15MB / 55.60MB 0.6s
#5 sha256:a9986cd6f37dbddae7862a6d4be71683472e7c2ea708e87db14f8a6393c00f00 2.10MB / 4.19MB 0.5s
#5 sha256:a9986cd6f37dbddae7862a6d4be71683472e7c2ea708e87db14f8a6393c00f00 4.19MB / 4.19MB 0.6s done
#5 extracting sha256:a9986cd6f37dbddae7862a6d4be71683472e7c2ea708e87db14f8a6393c00f00 0.1s done
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 12.58MB / 55.60MB 0.9s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 18.87MB / 55.60MB 1.1s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 28.31MB / 55.60MB 1.4s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 35.65MB / 55.60MB 1.5s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 40.89MB / 55.60MB 1.7s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 46.14MB / 55.60MB 1.8s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 54.53MB / 55.60MB 2.0s
#5 sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 55.60MB / 55.60MB 3.4s done
#5 extracting sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9
#5 extracting sha256:87919ed734a39bc185155d715bdcf2ce6c52d112ff642650d9e0e35502b481e9 0.7s done
#5 DONE 4.2s

#5 [build 1/8] FROM docker.io/library/node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
#5 extracting sha256:74849c662da757b89cfe8b5406d7beaaf491727ea6843cbba85b8889d1543956 0.0s done
#5 extracting sha256:66fa63c7a061939c4346f9c3c1ada45434b276dd4e4274721d6bf13cb8adec6e 0.0s done
#5 DONE 4.3s

#7 [stage-1 2/8] RUN apk add --no-cache postgresql17-client su-exec
#7 ...

#8 [build 2/8] WORKDIR /app
#8 DONE 3.1s

#9 [build 3/8] COPY package.json package-lock.json tsconfig*.json ./
#9 DONE 0.0s

#10 [build 4/8] COPY packages ./packages
#10 DONE 0.0s

#11 [build 5/8] COPY apps ./apps
#11 DONE 0.0s

#7 [stage-1 2/8] RUN apk add --no-cache postgresql17-client su-exec
#7 ...

#12 [build 6/8] COPY modules ./modules
#12 DONE 0.0s

#13 [build 7/8] COPY scripts/copy-modules.mjs ./scripts/copy-modules.mjs
#13 DONE 0.0s

#14 [build 8/8] RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
#14 1.390
#14 1.390 added 130 packages, and audited 137 packages in 1s
#14 1.390
#14 1.390 37 packages are looking for funding
#14 1.390   run `npm fund` for details
#14 1.391
#14 1.391 found 0 vulnerabilities
#14 1.391 npm notice
#14 1.391 npm notice New major version of npm available! 10.9.9 -> 12.2.2
#14 1.391 npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.2
#14 1.391 npm notice To update run: npm install -g npm@12.2.2
#14 1.391 npm notice
#14 1.495
#14 1.495 > siftable-headless@0.1.0 build
#14 1.495 > tsc -b && node scripts/copy-modules.mjs
#14 1.495
#14 3.363
#14 3.363 changed 2 packages, and audited 122 packages in 2s
#14 3.363
#14 3.363 36 packages are looking for funding
#14 3.363   run `npm fund` for details
#14 3.364
#14 3.364 found 0 vulnerabilities
#14 ...

#7 [stage-1 2/8] RUN apk add --no-cache postgresql17-client su-exec
#7 3.631 (1/9) Installing postgresql-common (1.3-r0)
#7 3.655   Executing postgresql-common-1.3-r0.pre-install
#7 3.715 (2/9) Installing lz4-libs (1.10.0-r1)
#7 3.743 (3/9) Installing libpq (18.7-r0)
#7 3.774 (4/9) Installing ncurses-terminfo-base (6.6_p20260516-r0)
#7 3.887 (5/9) Installing libncursesw (6.6_p20260516-r0)
#7 3.920 (6/9) Installing readline (8.3.3-r1)
#7 3.949 (7/9) Installing zstd-libs (1.5.7-r2)
#7 3.983 (8/9) Installing postgresql17-client (17.12-r0)
#7 4.046 (9/9) Installing su-exec (0.3-r0)
#7 4.079 Executing busybox-1.37.0-r31.trigger
#7 4.082 Executing postgresql-common-1.3-r0.trigger
#7 4.084 * Setting postgresql17 as the default version
#7 4.135 * find: /usr/share/man: No such file or directory
#7 4.334 *
#7 4.334 * You are using 'postgresql17'. It's recommended to upgrade to the latest
#7 4.334 * major version provided by package 'postgresql18'.
#7 4.334 * Use command 'pg_versions' to switch between versions.
#7 4.334 *
#7 4.335 OK: 16.7 MiB in 27 packages
#7 DONE 7.7s

#14 [build 8/8] RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts
#14 DONE 4.5s

#15 [stage-1 3/8] WORKDIR /app
#15 DONE 0.1s

#16 [stage-1 4/8] COPY scripts/admin.sh ./scripts/admin.sh
#16 DONE 0.4s

#17 [stage-1 5/8] COPY --from=build /app/node_modules ./node_modules
#17 DONE 2.0s

#18 [stage-1 6/8] COPY --from=build /app/package.json ./package.json
#18 DONE 0.2s

#19 [stage-1 7/8] COPY --from=build /app/packages ./packages
#19 DONE 0.1s

#20 [stage-1 8/8] COPY --from=build /app/apps ./apps
#20 DONE 0.1s

#21 exporting to image
#21 exporting layers
#21 exporting layers 1.0s done
#21 exporting manifest sha256:32ac2e568b25090977bb90a327d5ee78f8a8966814b91929bcb051f08f5345da 0.0s done
#21 exporting config sha256:3716dc13e2322d30d15b90d39f5220b82cccd571a1cffe77f96d0457ece905ab done
#21 exporting attestation manifest sha256:2de66af3592ea05f4645ce46b2bd3c72e0b945988a48a341874121cd91ec9b6e 0.0s done
#21 exporting manifest list sha256:b8b9d58988fbab04875a1ab77017113229cf12bfe81a3ae371abd5df6c7505e3
#21 exporting manifest list sha256:b8b9d58988fbab04875a1ab77017113229cf12bfe81a3ae371abd5df6c7505e3 done
#21 naming to docker.io/library/siftable-headless:local done
#21 unpacking to docker.io/library/siftable-headless:local
#21 unpacking to docker.io/library/siftable-headless:local 1.5s done
#21 DONE 2.6s

#22 resolving provenance for metadata file
#22 DONE 0.0s
{
  "principalId": "fa795fd1-bca9-4fa7-b0a6-342b1d9afdc7",
  "ownerId": "945bca0f-acbb-493d-8d58-ded7e76ae550",
  "scopeId": null,
  "credentialFile": "/run/sift/owner.json"
}
{"status":"ready","url":"http://127.0.0.1:8088","credentialFile":".local/owner.json","modules":"projects,context,work,planning,extensions"}
 Image siftable-headless:local Building
 Image siftable-headless:local Built
 Image pgvector/pgvector:pg17 Pulling
 605893accf60 Pulling fs layer 0B
 ef0b9aca4fbb Pulling fs layer 0B
 668cd6ea902f Pulling fs layer 0B
 2cb63c71a9bf Pulling fs layer 0B
 c879a6d9e752 Pulling fs layer 0B
 af1c4097986f Pulling fs layer 0B
 f4c7aa638871 Pulling fs layer 0B
 502716bb0323 Pulling fs layer 0B
 6fcdae2679cf Pulling fs layer 0B
 03ad3f411681 Pulling fs layer 0B
 7c4e3c588c24 Pulling fs layer 0B
 2d66c782e484 Pulling fs layer 0B
 db2b2896d2ea Pulling fs layer 0B
 349ba3c66c14 Pulling fs layer 0B
 124c0425e69b Pulling fs layer 0B
 8546da52b30b Pulling fs layer 0B
 f4c7aa638871 Downloading 6.11kB
 605893accf60 Downloading 1.166kB
 c879a6d9e752 Downloading 129B
 af1c4097986f Downloading 170B
 c879a6d9e752 Download complete 0B
 af1c4097986f Download complete 0B
 f4c7aa638871 Download complete 0B
 605893accf60 Download complete 0B
 502716bb0323 Download complete 0B
 2cb63c71a9bf Download complete 0B
 6fcdae2679cf Downloading 3.146MB
 ef0b9aca4fbb Downloading 1.408MB
 6fcdae2679cf Downloading 7.34MB
 03ad3f411681 Downloading 132.9kB
 ef0b9aca4fbb Downloading 1.408MB
 6fcdae2679cf Downloading 11.53MB
 03ad3f411681 Downloading 132.9kB
 ef0b9aca4fbb Downloading 1.408MB
 ef0b9aca4fbb Downloading 1.408MB
 6fcdae2679cf Downloading 13.63MB
 03ad3f411681 Downloading 132.9kB
 2d66c782e484 Downloading 1.049MB
 ef0b9aca4fbb Download complete 0B
 6fcdae2679cf Downloading 15.73MB
 03ad3f411681 Download complete 0B
 6fcdae2679cf Downloading 19.92MB
 2d66c782e484 Downloading 3.146MB
 7c4e3c588c24 Download complete 0B
 6fcdae2679cf Downloading 22.02MB
 2d66c782e484 Downloading 5.243MB
 6fcdae2679cf Downloading 25.17MB
 2d66c782e484 Downloading 6.291MB
 6fcdae2679cf Downloading 26.21MB
 2d66c782e484 Downloading 7.34MB
 2d66c782e484 Downloading 7.34MB
 6fcdae2679cf Downloading 28.31MB
 6fcdae2679cf Downloading 30.41MB
 2d66c782e484 Downloading 9.437MB
 6fcdae2679cf Downloading 33.55MB
 2d66c782e484 Downloading 10.49MB
 6fcdae2679cf Downloading 36.7MB
 2d66c782e484 Downloading 11.53MB
 2d66c782e484 Downloading 11.53MB
 6fcdae2679cf Downloading 38.8MB
 6fcdae2679cf Downloading 39.85MB
 2d66c782e484 Downloading 12.58MB
 2d66c782e484 Downloading 13.63MB
 6fcdae2679cf Downloading 44.04MB
 2d66c782e484 Downloading 14.68MB
 668cd6ea902f Downloading 1.049MB
 6fcdae2679cf Downloading 47.19MB
 668cd6ea902f Downloading 1.049MB
 6fcdae2679cf Downloading 51.38MB
 2d66c782e484 Downloading 15.73MB
 6fcdae2679cf Downloading 54.53MB
 2d66c782e484 Downloading 17.83MB
 668cd6ea902f Downloading 1.049MB
 2d66c782e484 Downloading 17.83MB
 668cd6ea902f Downloading 1.049MB
 6fcdae2679cf Downloading 54.53MB
 668cd6ea902f Downloading 2.097MB
 6fcdae2679cf Downloading 57.67MB
 2d66c782e484 Downloading 19.92MB
 6fcdae2679cf Downloading 59.77MB
 2d66c782e484 Downloading 20.97MB
 668cd6ea902f Downloading 2.097MB
 668cd6ea902f Downloading 2.097MB
 6fcdae2679cf Downloading 61.87MB
 2d66c782e484 Downloading 22.02MB
 2d66c782e484 Downloading 24.12MB
 668cd6ea902f Downloading 2.097MB
 6fcdae2679cf Downloading 65.01MB
 2d66c782e484 Downloading 24.12MB
 668cd6ea902f Downloading 2.097MB
 6fcdae2679cf Downloading 66.06MB
 668cd6ea902f Downloading 2.097MB
 6fcdae2679cf Downloading 68.16MB
 2d66c782e484 Downloading 25.17MB
 6fcdae2679cf Downloading 71.3MB
 2d66c782e484 Downloading 27.26MB
 668cd6ea902f Downloading 3.146MB
 6fcdae2679cf Downloading 75.5MB
 2d66c782e484 Downloading 28.14MB
 668cd6ea902f Downloading 3.146MB
 6fcdae2679cf Downloading 79.69MB
 2d66c782e484 Downloading 28.14MB
 668cd6ea902f Downloading 3.146MB
 db2b2896d2ea Downloading 1.049MB
 668cd6ea902f Downloading 3.146MB
 db2b2896d2ea Downloading 2.097MB
 6fcdae2679cf Downloading 81.79MB
 2d66c782e484 Downloading 28.14MB
 668cd6ea902f Downloading 4.194MB
 db2b2896d2ea Downloading 2.097MB
 6fcdae2679cf Downloading 83.89MB
 2d66c782e484 Downloading 28.14MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 4.194MB
 6fcdae2679cf Downloading 87.03MB
 2d66c782e484 Downloading 28.14MB
 2d66c782e484 Downloading 28.14MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 5.243MB
 6fcdae2679cf Downloading 91.23MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 7.34MB
 6fcdae2679cf Downloading 94.37MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 db2b2896d2ea Downloading 8.066MB
 6fcdae2679cf Downloading 98.57MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 668cd6ea902f Downloading 4.519MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 99.61MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 104.9MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 110.1MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 6fcdae2679cf Downloading 114.3MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 668cd6ea902f Downloading 4.519MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 db2b2896d2ea Downloading 8.066MB
 124c0425e69b Downloading 3.144kB
 6fcdae2679cf Downloading 117.4MB
 349ba3c66c14 Downloading 116B
 2d66c782e484 Downloading 28.14MB
 8546da52b30b Downloading 1.109MB
 668cd6ea902f Downloading 4.519MB
 2d66c782e484 Download complete 0B
 8546da52b30b Download complete 0B
 668cd6ea902f Download complete 0B
 db2b2896d2ea Download complete 0B
 124c0425e69b Download complete 0B
 6fcdae2679cf Download complete 0B
 349ba3c66c14 Download complete 0B
 2d66c782e484 Extracting 1B
 721f8a2a085c Download complete 0B
 2d66c782e484 Extracting 1B
 2d66c782e484 Extracting 1B
 2d66c782e484 Extracting 1B
 2d66c782e484 Extracting 1B
 605893accf60 Extracting 1B
 2d66c782e484 Pull complete 0B
 605893accf60 Pull complete 0B
 7c4e3c588c24 Pull complete 0B
 668cd6ea902f Pull complete 0B
 db2b2896d2ea Extracting 1B
 db2b2896d2ea Extracting 1B
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
 6fcdae2679cf Pull complete 0B
 2cb63c71a9bf Extracting 1B
 c879a6d9e752 Pull complete 0B
 af1c4097986f Pull complete 0B
 f4c7aa638871 Pull complete 0B
 502716bb0323 Pull complete 0B
 2cb63c71a9bf Pull complete 0B
 ef0b9aca4fbb Extracting 1B
 03ad3f411681 Pull complete 0B
 ef0b9aca4fbb Extracting 1B
 ef0b9aca4fbb Extracting 1B
 ef0b9aca4fbb Extracting 1B
 ef0b9aca4fbb Extracting 1B
 ef0b9aca4fbb Extracting 1B
 ef0b9aca4fbb Extracting 1B
 ef0b9aca4fbb Extracting 1B
 ef0b9aca4fbb Extracting 1B
 ef0b9aca4fbb Extracting 1B
 ef0b9aca4fbb Extracting 2B
 ef0b9aca4fbb Extracting 2B
 ef0b9aca4fbb Extracting 2B
 ef0b9aca4fbb Extracting 2B
 ef0b9aca4fbb Extracting 2B
 ef0b9aca4fbb Extracting 2B
 ef0b9aca4fbb Extracting 2B
 ef0b9aca4fbb Extracting 2B
 ef0b9aca4fbb Extracting 2B
 ef0b9aca4fbb Pull complete 0B
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
 Container siftable-headless-admin-run-88d06d06c5cf Creating
 Container siftable-headless-admin-run-88d06d06c5cf Created
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
  "runId": "1273908c-9c9e-4a61-8cfc-2bdec4304f16",
  "projectId": "8d3b2691-199e-45fd-ab1e-aeb22b46050c",
  "noteId": "43d34e38-2001-4829-a55e-5eb4cbcddb1d",
  "workId": "f9d45179-7376-4f6b-9440-c85b2201473d",
  "packetId": "2faa59f1-2f6d-424b-b636-d2f02f6b3068",
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
 Container siftable-headless-server-1 Started
RUN node packages/cli/dist/index.js work.get --config .local/owner.json --json {"id":"f9d45179-7376-4f6b-9440-c85b2201473d"}
PASS documented stop/start retains accepted work
RUN docker compose run --rm -T admin backup --output /run/sift/backup-001
RUN docker compose run --rm -T admin backup-verify --file /run/sift/backup-001
RUN docker compose run --rm -T admin restore --file /run/sift/backup-001 --database siftable_recovered
RUN docker compose stop server
 Container siftable-headless-server-1 Stopping
 Container siftable-headless-server-1 Stopped
RUN docker compose up -d --force-recreate server
 Container siftable-headless-db-1 Running
 Container siftable-headless-server-1 Recreate
 Container siftable-headless-server-1 Recreated
 Container siftable-headless-db-1 Waiting
 Container siftable-headless-db-1 Healthy
 Container siftable-headless-server-1 Starting
 Container siftable-headless-server-1 Started
RUN node packages/cli/dist/index.js modules.list --config .local/owner.json --json {}
RUN node packages/cli/dist/index.js work.get --config .local/owner.json --json {"id":"f9d45179-7376-4f6b-9440-c85b2201473d"}
RUN node packages/cli/dist/index.js notes.get --config .local/owner.json --json {"id":"43d34e38-2001-4829-a55e-5eb4cbcddb1d"}
PASS README backup/verify/restore/switch preserves actual CLI/MCP work and note
README CLEAN-ENVIRONMENT CHECK PASSED

$ docker cp sift-readme-50548711:/workspace/readme-receipt.json /Users/thomasmain/projects/siftable/.local/readme-50548711/receipt.json

$ docker rm -fv sift-readme-50548711
sift-readme-50548711

$ docker image rm siftable-readme-runner:50548711
Untagged: siftable-readme-runner:50548711
Deleted: sha256:ae36c2587687b898fffd04a3f23318019111f6e56367fd9e1e9e8759b9a1c183
