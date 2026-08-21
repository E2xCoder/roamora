# OpenTripPlanner 2.9 requires Java 25 (its shaded jar is compiled to
# class-file version 69 — Java 21 fails with UnsupportedClassVersionError,
# a real error hit and fixed earlier in this project's setup). No official
# lightweight OTP image was verified working in this environment, so this
# builds a small, self-contained one instead: a JRE base plus the real
# release jar, nothing else.
FROM eclipse-temurin:25-jre-jammy

ARG OTP_VERSION=2.9.0
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

RUN curl -fL -o otp-shaded.jar \
    "https://github.com/opentripplanner/OpenTripPlanner/releases/download/v${OTP_VERSION}/otp-shaded-${OTP_VERSION}.jar"

VOLUME ["/graph"]
EXPOSE 8080

# Default command loads a pre-built graph. To build one first (one-time, per
# destination, before the first `docker compose up`):
#   docker compose run --rm otp --build --save /graph
# with the destination's .osm.pbf and GTFS .zip already placed in
# ./infra/otp/graph_dir on the host (see infra/README.md).
ENTRYPOINT ["java", "-Xmx4G", "-jar", "otp-shaded.jar"]
CMD ["--load", "/graph"]
