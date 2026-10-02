# syntax=docker/dockerfile:1

# ---- Stage 1: build the React SPA into frontend/dist ----
# Build stages run on the build host's platform; only the Go binary is
# cross-compiled, so multi-arch builds don't need emulation.
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: compile a static Go binary with the SPA embedded ----
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS backend
RUN apk add --no-cache ca-certificates
WORKDIR /src
# go.mod replaces github.com/fullstorydev/grpcui with ./grpcui-old
COPY go.mod go.sum ./
COPY grpcui-old/go.mod grpcui-old/go.sum grpcui-old/
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY grpcui-old/ grpcui-old/
COPY *.go ./
COPY --from=frontend /src/frontend/dist frontend/dist
ARG TARGETOS TARGETARCH
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/grpcui .

# ---- Stage 3: minimal runtime ----
FROM scratch
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# Same binary path and port as the fullstorydev/grpcui image, so this is a
# drop-in replacement: args such as `-plaintext host:port` work unchanged.
COPY --from=backend /out/grpcui /bin/grpcui
ENV GRPCUI_BIND=0.0.0.0 \
    PORT=8080 \
    GRPCUI_OPEN_BROWSER=false
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/bin/grpcui"]
