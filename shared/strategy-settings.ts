/** 배포 잠금 여부를 한 규칙으로 해석한다. */
export function strategyLocked(raw: string | undefined): boolean {
  return (raw ?? "false").toLowerCase() === "true";
}

/**
 * 잠금이 꺼져 있으면 UI/KV 선택값이 배포 기본값보다 우선한다.
 * 잠금이 켜진 비상상황에서는 배포값을 우선하고 저장값은 폴백으로만 남긴다.
 */
export function strategyPreference<T>(locked: boolean, deployed: T | null | undefined, stored: T | null | undefined): Array<T | null | undefined> {
  return locked ? [deployed, stored] : [stored, deployed];
}
