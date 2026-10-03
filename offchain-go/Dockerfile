# One image per service, selected by the SERVICE build arg (keeper|indexer|relayer).
# A static binary on a distroless base keeps the image tiny and dependency-free.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG SERVICE
RUN test -n "$SERVICE" && CGO_ENABLED=0 go build -trimpath -o /out/svc ./cmd/${SERVICE}

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/svc /svc
ENTRYPOINT ["/svc"]
