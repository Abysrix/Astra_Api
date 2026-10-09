import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "Astra_Api";
export default defineRailway(() => {
  const Astra_Api = service("Astra_Api", {
    // dockerfilePath from CaC: "Dockerfile"
    // builder from CaC: "DOCKERFILE"
    source: github("Abysrix/Astra_Api", { branch: "main", checkSuites: false }),
    start: "node custom-server.js",
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    replicas: { "sfo": 1 },
    networking: { privateNetworkEndpoint: "astraapi" },
  });

  return project("desirable-healing", {
    variables: { managed: false },
    resources: [Astra_Api],
  });
});
