import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strategyLocked, strategyPreference } from "../shared/strategy-settings";

assert.equal(strategyLocked("false"), false);
assert.equal(strategyLocked("TRUE"), true);
assert.deepEqual(strategyPreference(false, "onto", "ta"), ["ta", "onto"], "잠금 해제 시 UI/KV 선택값이 우선해야 한다");
assert.deepEqual(strategyPreference(true, "onto", "ta"), ["onto", "ta"], "비상 잠금 시에만 배포값이 우선해야 한다");

const config = await readFile(resolve(process.cwd(), "wrangler.jsonc"), "utf8");
assert.match(config, /"AUTO_ENGINE_LOCKED"\s*:\s*"false"/, "국내 전략 잠금이 배포 설정에서 해제되어야 한다");
assert.match(config, /"US_ENGINE_LOCKED"\s*:\s*"false"/, "미국 전략 잠금이 배포 설정에서 해제되어야 한다");

console.log("✓ live strategy settings tests passed");
