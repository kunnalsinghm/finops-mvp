"use strict";

require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const routes = require("./routes");
const policyAgent = require("./policyAgent");
const treasuryAgent = require("./treasuryAgent");
const circuitBreaker = require("./circuitBreaker");

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", routes);
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 4200;
const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS || 15000);
const CIRCUIT_BREAKER_INTERVAL_MS = Number(process.env.CIRCUIT_BREAKER_INTERVAL_MS || 5000);

async function runAllAgents(trigger) {
  try {
    treasuryAgent.runTreasuryCycle({ trigger });
  } catch (err) {
    console.error("Treasury Agent cycle failed:", err.message);
  }
  try {
    await policyAgent.runCycle({ trigger });
  } catch (err) {
    console.error("Policy Agent cycle failed:", err.message);
  }
}

async function runCircuitBreaker(trigger) {
  try {
    await circuitBreaker.runCircuitBreakerCycle({ trigger });
  } catch (err) {
    console.error("Circuit breaker cycle failed:", err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Autopilot listening on http://localhost:${PORT}`);
  console.log(
    `Mode: ${process.env.MODE || "mock"} | Agent cycle: ${CYCLE_INTERVAL_MS}ms | Circuit breaker: ${CIRCUIT_BREAKER_INTERVAL_MS}ms`
  );
  runAllAgents("startup").catch((err) => console.error("Startup agent cycle failed:", err.message));
  runCircuitBreaker("startup").catch((err) => console.error("Startup circuit breaker failed:", err.message));
  setInterval(() => {
    runAllAgents("scheduled").catch((err) => console.error("Scheduled agent cycle failed:", err.message));
  }, CYCLE_INTERVAL_MS);
  setInterval(() => {
    runCircuitBreaker("scheduled").catch((err) => console.error("Scheduled circuit breaker failed:", err.message));
  }, CIRCUIT_BREAKER_INTERVAL_MS);
});
