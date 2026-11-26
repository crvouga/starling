FROM alpine:3.23 AS download
ADD https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.1.4/CLIProxyAPI_8.1.4_linux_amd64_no-plugin.tar.gz /tmp/proxy.tar.gz
RUN echo "6c03da0e408f63ed7190f4b9f6bd1011b034e9d7601ea07adc1701c5f4e1b2f9  /tmp/proxy.tar.gz" | sha256sum -c - && tar -xzf /tmp/proxy.tar.gz && mv cli-proxy-api /usr/local/bin/proxy
FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=download /usr/local/bin/proxy /usr/local/bin/proxy
CMD ["sleep","infinity"]
