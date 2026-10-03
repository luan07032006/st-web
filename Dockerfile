FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY Backend/pom.xml Backend/pom.xml
COPY Backend/src Backend/src
RUN mvn -B -f Backend/pom.xml package dependency:copy-dependencies -DincludeScope=runtime

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/Backend/target/classes Backend/target/classes
COPY --from=build /app/Backend/target/dependency Backend/target/dependency
COPY Frontend Frontend
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080
CMD ["java", "-cp", "Backend/target/classes:Backend/target/dependency/*", "vn.bangtrang.backend.Main"]
