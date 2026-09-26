/**
 * 살아 있는 민감도 표 — 온톨로지 MLOps 의 "배포" 단계.
 *
 * 학습기(scripts/onto-learn.ts)가 만든 후보 표를 사람이 승격하면 KV 에 실리고,
 * 전략·레이더·결론 엔진이 다음 계산부터 그 표를 쓴다(코드 재배포 불필요).
 *
 * 안전장치:
 *  - 승격은 거래 암호(TRADE_TOKEN) 필요 — 자동 승격 없음. 게이트(백테스트 비교)
 *    결과가 body 에 함께 와야 하고, 탈락(pass=false) 표는 거부한다.
 *  - 부호 검증: 정적 표와 부호가 다른 가중치는 거부 — 데이터 잡음으로 경제적
 *    인과의 방향을 뒤집지 않는다.
 *  - 이전 표는 sens:prev 에 남아 /api/onto/rollback 한 번으로 복귀한다.
 */
import type { Env } from "./env";
import { SENSITIVITY, MACRO, type MacroId } from "../shared/ontology";
import { ApiError } from "./util";

export interface LiveSens {
  version: string;
  promotedAt: number;
  table: Record<string, Partial<Record<MacroId, number>>>;
  gate?: { current: number; candidate: number; pass: boolean };
}

const KEY = "sens:live";
const PREV = "sens:prev";
const VALID_MACRO = new Set<string>(MACRO.map((m) => m.id));

/** 아이솔레이트 메모리 캐시 (60초) — KV 읽기를 아낀다 */
let mem: { at: number; v: LiveSens | null } | null = null;

/** 지금 쓸 한국 민감도 표. 승격본이 없으면 정적 표. */
export async function liveSensitivity(env: Env): Promise<{ table: Record<string, Partial<Record<MacroId, number>>>; version: string }> {
  if (!mem || Date.now() - mem.at > 60_000) {
    mem = { at: Date.now(), v: (await env.CACHE.get(KEY, "json").catch(() => null)) as LiveSens | null };
  }
  return mem.v ? { table: mem.v.table, version: mem.v.version } : { table: SENSITIVITY, version: "static" };
}

function validate(table: unknown): Record<string, Partial<Record<MacroId, number>>> {
  if (!table || typeof table !== "object") throw new ApiError(400, "invalid_table");
  const out: Record<string, Partial<Record<MacroId, number>>> = {};
  for (const [sector, sens] of Object.entries(table as Record<string, unknown>)) {
    const staticSens = (SENSITIVITY as Record<string, Partial<Record<string, number>>>)[sector];
    if (!staticSens) throw new ApiError(400, "unknown_sector", { sector });
    out[sector] = {};
    for (const [macroId, w] of Object.entries(sens as Record<string, unknown>)) {
      if (!VALID_MACRO.has(macroId)) throw new ApiError(400, "unknown_macro", { macroId });
      const num = Number(w);
      if (!Number.isFinite(num) || Math.abs(num) > 1) throw new ApiError(400, "weight_out_of_range", { sector, macroId, w });
      const sw = staticSens[macroId];
      if (sw !== undefined && Math.sign(num) !== Math.sign(sw) && num !== 0) {
        throw new ApiError(400, "sign_flip_rejected", { sector, macroId, static: sw, candidate: num });
      }
      out[sector][macroId as MacroId] = num;
    }
  }
  return out;
}

export async function promoteSensitivity(env: Env, body: { candidate?: unknown; gate?: { pass?: boolean; current?: number; candidate?: number } }): Promise<LiveSens> {
  if (!body.gate?.pass) throw new ApiError(400, "gate_not_passed", { hint: "onto-learn 게이트를 통과한 후보만 승격할 수 있습니다." });
  const table = validate(body.candidate);
  const prev = (await env.CACHE.get(KEY, "json").catch(() => null)) as LiveSens | null;
  if (prev) await env.CACHE.put(PREV, JSON.stringify(prev));
  const live: LiveSens = {
    version: `learned-${new Date().toISOString().slice(0, 10)}`,
    promotedAt: Date.now(),
    table,
    gate: { current: Number(body.gate.current ?? 0), candidate: Number(body.gate.candidate ?? 0), pass: true },
  };
  await env.CACHE.put(KEY, JSON.stringify(live));
  mem = null;
  return live;
}

export async function rollbackSensitivity(env: Env): Promise<{ restored: string }> {
  const prev = (await env.CACHE.get(PREV, "json").catch(() => null)) as LiveSens | null;
  if (prev) {
    await env.CACHE.put(KEY, JSON.stringify(prev));
    mem = null;
    return { restored: prev.version };
  }
  await env.CACHE.delete(KEY).catch(() => {});
  mem = null;
  return { restored: "static" };
}
