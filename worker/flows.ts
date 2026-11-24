/**
 * 수급 요인 — 외국인 순매수 (KIS 투자자별 매매동향).
 *
 * "누가 사고 있나"는 가격에 아직 다 반영되지 않은 요인이다. 대형주 5종목
 * (삼성전자·SK하이닉스·현대차·KB금융·NAVER)의 최근 외국인 순매수를 합산해
 * 시장 수급의 프록시로 쓴다 — 전 종목을 긁는 것보다 거칠지만, KIS 호출
 * 예산(5회/시간)으로 방향은 충분히 잡힌다.
 *
 * KIS 미설정·오류 시 null — 결론 엔진은 수급 없이도 동작한다(요인 하나 결측일 뿐).
 */
import type { Env } from "./env";
import { kisCall, kisConfig } from "./kis";
import { cached } from "./util";

export interface InvestorFlow {
  available: boolean;
  /** 최근 N 일 합산 */
  days: number;
  /** 외국인 순매수 대금(원, 프록시 5종목 합산) */
  foreignNetBuyKrw: number;
  /** 기관 순매수 대금(원) */
  institutionNetBuyKrw: number;
  basis: string;
  generatedAt: number;
}

/** 시장 수급 프록시 — 시총 상위 + 업종 대표 */
const PROXY_CODES = ["005930", "000660", "005380", "105560", "035420"];
const DAYS = 3;

async function fetchFlow(env: Env): Promise<InvestorFlow> {
  const cfg = kisConfig(env);
  let foreign = 0;
  let inst = 0;
  let ok = 0;
  for (const code of PROXY_CODES) {
    try {
      const out = await kisCall(env, cfg, {
        method: "GET",
        path: "/uapi/domestic-stock/v1/quotations/inquire-investor",
        trId: "FHKST01010900",
        query: { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code },
      });
      const rows = (out["output"] ?? []) as Record<string, string>[];
      // 일별 행: frgn_ntby_tr_pbmn(외국인 순매수 대금)·orgn_ntby_tr_pbmn(기관) — KIS 투자자별 대금은 백만원 단위
      for (const r of rows.slice(0, DAYS)) {
        foreign += (Number(r["frgn_ntby_tr_pbmn"] ?? 0) || 0) * 1_000_000;
        inst += (Number(r["orgn_ntby_tr_pbmn"] ?? 0) || 0) * 1_000_000;
      }
      ok++;
    } catch {
      /* 종목 하나 실패는 무시 */
    }
  }
  if (!ok) return { available: false, days: DAYS, foreignNetBuyKrw: 0, institutionNetBuyKrw: 0, basis: "KIS 수급 조회 실패", generatedAt: Date.now() };
  return {
    available: true,
    days: DAYS,
    foreignNetBuyKrw: foreign,
    institutionNetBuyKrw: inst,
    basis: `대형주 ${ok}종목 프록시(삼성전자·하이닉스·현대차·KB·NAVER)`,
    generatedAt: Date.now(),
  };
}

/** 1시간 캐시 — KIS 호출 5회/시간. 미설정이면 즉시 null. */
export async function getInvestorFlow(env: Env): Promise<InvestorFlow | null> {
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return null;
  const { data } = await cached(env, "flow:v2", 3600, () => fetchFlow(env), (r) => (r.available ? 3600 : 600));
  return data;
}
