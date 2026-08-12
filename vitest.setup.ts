import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "agent-test-home-"));
process.env.AGENT_HOME = tmp;
const configDir = join(tmp, ".gemini", "agent");
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "profiles.json"), JSON.stringify({
  "default": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "test-profile": {
    "baseUrl": "https://test.api.invalid",
    "apiKeyEnv": "TEST_OPENAI_KEY"
  }
}));
