import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const agentDir = join(process.env.HOME, ".pi", "agent");
const appId = "fixture-owned-daemon";
mkdirSync(join(agentDir, "feishu"), { recursive: true });
writeFileSync(join(agentDir, "feishu", "config.pi.json"), JSON.stringify({
  appId, appSecret: "fixture-secret", autoStart: true,
}));
const key = `ax-feishu-bridge.gateway.${appId}`;
writeFileSync(join(agentDir, "locks.json"), JSON.stringify({
  [key]: {
    key, pid: process.pid, token: "fixture-owner", cwd: process.cwd(),
    startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    status: "connected",
  },
}));
process.env.PI_FEISHU_DAEMON = "1";
delete process.env.PI_FEISHU_CHILD_SESSION;
const { default: extension } = await import("../../src/adapters/pi/index.ts");
let registrations = 0;
extension({
  registerTool() { registrations++; },
  registerCommand() { registrations++; },
  on() { registrations++; },
});
// An inherited daemon flag must not let a nested factory exit the parent process.
await new Promise(resolve => setTimeout(resolve, 150));
console.log(`owned-daemon-bootstrap-survived:${registrations}`);
