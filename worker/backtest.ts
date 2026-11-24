/**
 * 백테스트 성적표 제공.
 *
 * 백테스트는 워커에서 돌릴 수 없다 — 종목 수백 개의 2년치 시세를 받아야 하고
 * 서브리퀘스트 한도(50)와 실행 시간을 한참 넘는다. 그래서 **개발 환경에서 실제로
 * 돌린 결과를 데이터 파일로 고정**해 두고 그대로 내려준다.
 *
 * 화면이 숫자를 지어내지 않게 하려는 조치다. 숫자에는 측정 날짜와 재현 명령이
 * 붙어 있어 누구든 같은 명령으로 다시 돌려 볼 수 있다.
 */
import results from "../shared/backtest-results.json";

export function backtestResults(): unknown {
  return results;
}
