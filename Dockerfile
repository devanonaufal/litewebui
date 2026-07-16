# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates git
COPY . .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /litewebui .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates \
  && adduser -D -H -u 65532 app \
  && mkdir -p /data \
  && chown app:app /data
COPY --from=build /litewebui /litewebui
ENV LISTEN=:3050 \
    DATA_DIR=/data \
    NINEROUTER_BASE_URL=http://127.0.0.1:20128/v1
EXPOSE 3050
VOLUME ["/data"]
USER app
ENTRYPOINT ["/litewebui"]
