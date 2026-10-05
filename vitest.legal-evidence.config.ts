import base from "./vitest.config.ts";
export default {
  ...base,
  test: {
    ...base.test,
    include: [
      "src/agents/legal-evidence/*.test.ts",
      "src/agents/pi-embedded-runner/run.legal-evidence.test.ts",
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
};
