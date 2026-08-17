/**
 * 3D 온톨로지 그래프 — 메인 화면.
 *
 * 세 층을 세 개의 동심원 고리로 세워 두고, 그 사이를 신호가 흐르는 모습을 보여 준다.
 *
 *      위 고리   거시요인 8개      (유가·환율·금리·반도체·코스피·중국·VIX·금)
 *      가운데    섹터 14개         (민감도 표가 이어 주는 층)
 *      아래 고리 종목 20개         (실제로 살 수 있는 것)
 *
 * 선은 "지금 실제로 흐르고 있는" 기여도만 그린다. 민감도표 전체를 다 그리면
 * 그림은 화려해지지만 무엇이 지금 중요한지는 오히려 안 보인다.
 * 선 위를 흐르는 점의 방향과 속도가 신호의 부호와 세기다.
 */
import * as THREE from "three";

export interface MacroNode {
  id: string;
  nameKo: string;
  changePct: number;
  value: number;
  newsImpact?: number;
}

export interface TickerNode {
  code: string;
  nameKo: string;
  score: number;
  ontologyScore: number;
  priceScore: number;
  newsScore: number;
  price: number;
  changePct: number;
  edges: { macroId: string; sector: string; contribution: number }[];
}

export interface OntoState {
  macro: MacroNode[];
  scores: TickerNode[];
  riskOff: number;
  /** 거시요인 사이의 인과 (의미층) */
  macroLinks?: { from: string; to: string; sign: 1 | -1; ko: string }[];
  /** 거시 층의 의미론적 클러스터 — 배치 순서와 캡션에 쓴다 */
  macroClusters?: { nameKo: string; ids: string[] }[];
  /** 전체 섹터와 민감도 — 결론이 없을 때의 폴백 층 */
  sectors?: { sector: string; sensitivity: Record<string, number> }[];
  /**
   * 온톨로지 결론 — 섹터·종목은 온톨로지의 구성물이 아니라 분석의 출력이므로,
   * 결론에 오른 것만 그래프에 세운다.
   */
  verdict?: {
    sectors: { recommend: VerdictSectorNode[]; avoid: VerdictSectorNode[] };
    stocks: { recommend: VerdictStockNode[]; avoid: VerdictStockNode[] };
  };
}

export interface VerdictSectorNode {
  sector: string;
  score: number;
  edges: { macroId: string; contribution: number }[];
}

export interface VerdictStockNode {
  code: string;
  name: string;
  sector: string | null;
  score: number;
}

export interface Onto3DOptions {
  onSelect: (kind: "macro" | "sector" | "ticker", id: string) => void;
  onHover: (label: string | null, x: number, y: number) => void;
  /** Ctrl 없이 휠을 굴렸을 때 — "확대는 Ctrl+스크롤" 힌트를 잠깐 띄우는 용도 */
  onScrollHint?: () => void;
  /** 노드 포커스 변경 — 좌상단 정보 카드용. null = 포커스 해제 */
  onFocus?: (info: { id: string; kind: "macro" | "sector" | "ticker"; label: string; sub: string; degree: number } | null) => void;
}

type NodeKind = "macro" | "sector" | "ticker";

interface NodeObj {
  kind: NodeKind;
  id: string;
  label: string;
  sub: string;
  pos: THREE.Vector3;
  sprite: THREE.Sprite;
  dot: THREE.Mesh;
  tone: number; // -1 ~ 1
}

interface EdgeObj {
  from: string;
  to: string;
  fromKind: NodeKind;
  toKind: NodeKind;
  contribution: number;
  curve: THREE.Curve<THREE.Vector3>;
  line: THREE.Line;
  pulse: THREE.Mesh;
  phase: number;
  /** 지금 작동하지 않는 인과 링크 — 구조만 흐리게 남긴다 */
  dim?: boolean;
}

/* ── 3단 무대(계단식 밴드) 배치 ──────────────────────────
 * 원반 3겹(깔대기) 배치는 층이 안 읽히고 간선이 중앙에서 엉킨다는 피드백(2026-08-17)으로 폐기.
 * 거시요인(위) → 섹터(가운데) → 종목(아래) 를 카메라를 향한 얕은 호(암피시어터) 3단으로 쌓아
 * "위에서 아래로 신호가 흐르는" 인과 구조가 그대로 보이게 한다. */
const Y = { macro: 3.0, sector: 0, ticker: -3.0 };
const BAND_W = 11; // 밴드 가로폭 — 무대 시야(세로형 종횡비) 안에 좌우 끝 라벨까지 들어오는 폭
const bandZ = (x: number) => -(x * x) / 15; // 얕은 포물선 — 좌우 끝이 뒤로 물러나 깊이감만 남긴다

/**
 * 라벨은 화면 픽셀 크기 고정(sizeAttenuation=false).
 * 텍스처를 표시 크기에 정확히 맞춰 그린다 — 큰 텍스처(512px)를 ~100px로 축소하면
 * 밉맵 보간으로 글자가 "초점 안 맞은 사진"처럼 뭉개진다(2026-08-17 피드백의 원인).
 */
/* 2026-08-17 "폰트 너무 크다" 피드백으로 한 단계 축소 — 텍스처는 표시 크기에
 * 맞춰 다시 그려지므로 줄여도 선명도는 그대로다 */
const LABEL_PX: Record<NodeKind, number> = { macro: 27, sector: 21, ticker: 24 };
const LABEL_ASPECT = 3.2; // 텍스처 512×160 좌표계의 가로/세로 비
/** fov 42° 카메라에서 sizeAttenuation=false 스프라이트의 화면높이 = scale.y × 캔버스높이 × PROJ11/2 */
const PROJ11 = 1 / Math.tan(((42 / 2) * Math.PI) / 180);

const UP = new THREE.Color("#f87171");
const DOWN = new THREE.Color("#60a5fa");
const FLAT = new THREE.Color("#64748b");
const SECTOR_C = new THREE.Color("#94a3b8");

function toneColor(tone: number): THREE.Color {
  if (Math.abs(tone) < 0.04) return FLAT.clone();
  const target = tone > 0 ? UP : DOWN;
  return FLAT.clone().lerp(target, Math.min(1, Math.abs(tone) * 1.6 + 0.35));
}

/** 라벨 스프라이트 (캔버스로 그려 항상 카메라를 향하게 한다).
 *  해상도를 실제 표시 크기(px × DPR × 2)에 맞춰 그린다 — 2×라 밉맵 1단계가
 *  정확히 화면 크기와 일치해 글자가 또렷하다. 좌표계는 512×160 그대로 쓰고 scale 로 맞춘다. */
function labelSprite(title: string, sub: string, color: THREE.Color, kind: NodeKind): THREE.Sprite {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const H = Math.max(48, Math.round(LABEL_PX[kind] * dpr * 2));
  const W = Math.round(H * LABEL_ASPECT);
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.scale(H / 160, H / 160); // 이하 좌표는 기존 512×160 기준
  const hex = `#${color.getHexString()}`;

  /* 유리판 칩 — 진한 남색 유리 + 색상 테두리.
   * 칩마다 넣던 색 글로우(shadowBlur)는 제거: 수십 개가 겹치면 밝은 배경에서
   * 붉은 연무가 되어 "흐리다"는 인상의 주범이었다(2026-08-17 실측). */
  const grad = ctx.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0, "rgba(17,27,50,0.94)");
  grad.addColorStop(1, "rgba(7,12,26,0.9)");
  ctx.fillStyle = grad;
  ctx.strokeStyle = hex;
  ctx.lineWidth = 3.5;
  // 알약(pill) — 2026-08-17 "라벨 동그랗게 + 테두리" 피드백
  ctx.beginPath();
  ctx.roundRect(4, 4, 512 - 8, 160 - 8, (160 - 8) / 2);
  ctx.fill();
  ctx.stroke();

  // 왼쪽 계층 색 점 — 참고 디자인의 노드 점 문법
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.arc(52, 80, 13, 0, Math.PI * 2);
  ctx.fill();

  // 글자를 알약 높이의 40%로 — 글자가 작아서 뭉개져 보이던 문제의 다른 절반
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f8fafc";
  ctx.font = "700 64px Pretendard, system-ui, sans-serif";
  ctx.fillText(title, 256 + 8, sub ? 80 - 24 : 80, 512 - 84);
  if (sub) {
    ctx.fillStyle = hex;
    ctx.font = "600 40px 'Fira Code', ui-monospace, monospace";
    ctx.fillText(sub, 256 + 8, 80 + 34, 512 - 84);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false }),
  );
  sprite.userData.kind = kind; // 표시 크기는 resize()/animate() 에서 캔버스 높이에 맞춰 계산
  return sprite;
}

/** 포커스 글로우 — 고른 노드 뒤에서 맥동하는 금색 후광 (가산 블렌딩이라 글자를 가리지 않는다) */
function makeHalo(): THREE.Sprite {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 10, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(232,192,106,0.85)");
  g.addColorStop(0.4, "rgba(217,164,65,0.35)");
  g.addColorStop(1, "rgba(217,164,65,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
    sizeAttenuation: false, blending: THREE.AdditiveBlending, opacity: 0.9,
  }));
  sprite.visible = false;
  return sprite;
}

export class Ontology3D {
  private canvas: HTMLCanvasElement;
  private opts: Onto3DOptions;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private world = new THREE.Group();
  private nodes: NodeObj[] = [];
  private edges: EdgeObj[] = [];
  /** 클러스터 캡션 등 픽 대상이 아닌 장식 스프라이트 */
  private captions: THREE.Sprite[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private clock = new THREE.Clock();
  private frames = 0;

  /** 그래프 상시 노드가 아닌 종목을 골랐을 때 임시로 꽂아 넣은 노드·간선 */
  private spotlight: { ticker: TickerNode; nodes: NodeObj[]; edges: EdgeObj[] } | null = null;
  /** 포커스 노드 뒤의 금색 후광 */
  private halo = makeHalo();
  private haloT = 0;
  private lastMacro = new Map<string, MacroNode>();

  /** 밝은 테마 여부 — 흐림(dim) 강도를 낮춰야 밝은 무대에서 뿌옇게 안 보인다 */
  private lightMode = false;
  private autoRotate = true;
  private dragging = false;
  private dragMoved = 0;
  private last = { x: 0, y: 0 };
  private rotY = 0; // 계단식 밴드는 정면이 기본 — 좌우 스웨이만 한다
  private rotX = -0.18;
  private targetZoom = 17.5;
  /** 캔버스 CSS 높이 — 라벨 화면픽셀 크기 계산용 */
  private hostH = 720;
  private swayT = 0;
  /** 층 제목 칩 — setState 로 지워지지 않는 상설 장식 */
  private bandDecor: THREE.Sprite[] = [];
  private focus: string | null = null;
  private hoverId: string | null = null;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, opts: Onto3DOptions) {
    this.canvas = canvas;
    this.opts = opts;
  }

  init(): void {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(0, 0, this.targetZoom);
    this.scene.add(this.world);
    this.world.position.y = -0.4; // 3단 밴드(위 +4.5 ~ 아래 -3.7)의 무게중심을 화면 가운데로
    this.scene.add(new THREE.AmbientLight(0xdbeafe, 1.2));
    this.buildBands();
    this.bindEvents();
    this.resize();
    this.animate();
  }

  /** 3단 밴드를 눈으로 구분해 주는 받침 호 + 층 제목 — 깔대기 대신 계단식 무대 */
  private buildBands(): void {
    const titles: [keyof typeof Y, string, string][] = [
      ["macro", "거시요인", "원인"],
      ["sector", "섹터", "전파"],
      ["ticker", "종목", "결론"],
    ];
    const gold = new THREE.Color("#d9a441");
    for (const [key, name, sub] of titles) {
      // 받침 호 — 밴드 바로 아래를 따라 흐르는 가는 선
      const pts: THREE.Vector3[] = [];
      for (let x = -BAND_W / 2 - 0.4; x <= BAND_W / 2 + 0.4; x += 0.35) {
        pts.push(new THREE.Vector3(x, Y[key] - 0.75, bandZ(x)));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x27548d, transparent: true, opacity: 0.85 }),
      );
      this.world.add(line);
      // 층 제목 — 왼쪽 끝, 금색. 층이 무엇인지 그래프 안에서 바로 읽힌다
      const chip = labelSprite(name, sub, gold.clone(), "macro");
      this.applyLabelScale(chip, "macro");
      const tx = -BAND_W / 2 + 0.4; // 카메라 시야 안, 밴드 왼쪽 위
      chip.position.set(tx, Y[key] + 1.15, bandZ(tx));
      this.world.add(chip);
      this.bandDecor.push(chip);
    }
  }

  /** 데이터가 바뀔 때마다 노드·간선을 다시 세운다 */
  setState(state: OntoState): void {
    // 갱신 직전에 스포트라이트가 켜져 있었다면 새 그래프에도 다시 켠다.
    const keepSpot = this.focus && this.spotlight?.ticker.code === this.focus ? this.spotlight.ticker : null;
    this.lastMacro = new Map(state.macro.map((m) => [m.id, m]));
    for (const n of this.nodes) {
      this.world.remove(n.sprite, n.dot);
      (n.sprite.material as THREE.SpriteMaterial).map?.dispose();
      n.sprite.material.dispose();
    }
    for (const e of this.edges) this.world.remove(e.line, e.pulse);
    for (const c of this.captions) {
      this.world.remove(c);
      (c.material as THREE.SpriteMaterial).map?.dispose();
      c.material.dispose();
    }
    this.nodes = [];
    this.edges = [];
    this.captions = [];
    this.spotlight = null;

    const macroById = new Map(state.macro.map((m) => [m.id, m]));
    const effVal = (m: MacroNode) => Math.max(-1, Math.min(1, m.value + 0.4 * (m.newsImpact ?? 0)));

    /* ── 개념 그래프 ──────────────────────────────────
     * 종목은 온톨로지의 "개념"이 아니라 인스턴스라 상시 노드에서 뺐다.
     * 기본 화면 = 거시(의미 클러스터로 배치) + 거시 간 인과 + 섹터.
     * 종목은 검색·목록에서 골랐을 때 스포트라이트로만 얹힌다(showTicker). */

    // 거시 노드를 의미 클러스터 순서로 배치 — "나열"이 아니라 "어떤 힘인가"로 묶는다
    const clusters = state.macroClusters?.length
      ? state.macroClusters
      : [{ nameKo: "", ids: state.macro.map((m) => m.id) }];
    const ordered: { m: MacroNode; cluster: number }[] = [];
    clusters.forEach((c, ci) => {
      for (const id of c.ids) {
        const m = macroById.get(id);
        if (m) ordered.push({ m, cluster: ci });
      }
    });
    for (const m of state.macro) if (!ordered.some((o) => o.m.id === m.id)) ordered.push({ m, cluster: -1 });

    /* 밴드 위 자리: i 번째 노드를 가로로 고르게 펴고, 이웃끼리 높이를 엇갈려 겹침을 줄인다 */
    const place = (i: number, n: number, y: number, stagger: number) => {
      const t = n <= 1 ? 0.5 : i / (n - 1);
      const x = (t - 0.5) * BAND_W;
      return new THREE.Vector3(x, y + (i % 2 ? stagger : -stagger), bandZ(x));
    };

    ordered.forEach(({ m }, i) => {
      const pos = place(i, ordered.length, Y.macro, 0.55);
      this.addNode("macro", m.id, m.nameKo, `${m.changePct >= 0 ? "+" : ""}${m.changePct}%`, pos, m.value);
    });
    // 클러스터 캡션 (픽 대상이 아니므로 nodes 에 넣지 않는다) — 해당 구간 위에 띄운다
    clusters.forEach((c, ci) => {
      const idxs = ordered.map((o, i) => (o.cluster === ci ? i : -1)).filter((i) => i >= 0);
      if (!idxs.length || !c.nameKo) return;
      const mid = (idxs[0] + idxs[idxs.length - 1]) / 2;
      const t = ordered.length <= 1 ? 0.5 : mid / (ordered.length - 1);
      const x = (t - 0.5) * BAND_W;
      const sprite = labelSprite(`⟨ ${c.nameKo} ⟩`, "", SECTOR_C.clone(), "sector");
      sprite.position.set(x, Y.macro + 1.5, bandZ(x));
      this.world.add(sprite);
      this.captions.push(sprite);
      this.applyLabelScale(sprite, "sector");
    });

    /* 가운데·아래 층 = 결론의 시각화.
     * 결론(verdict)이 있으면: 추천/회피에 오른 섹터와 종목만 세운다 — 그래프가
     * "온톨로지 분석 결과 이런 섹터·이런 종목"을 그대로 보여주는 화면이 된다.
     * 결론이 아직 없으면(로딩 초기): 민감도 표 기반 폴백. */
    /* ── 배리센터 정렬 ──────────────────────────────
     * 아래 층 노드를 "자기와 연결된 위층 노드들의 가중평균 x" 아래에 놓는다
     * (계층 그래프의 교차 최소화 정석). 인과선이 거의 수직으로 떨어져
     * 가운데서 긴 대각선이 엉키던 문제가 사라진다. */
    const macroX = new Map(this.nodes.filter((n) => n.kind === "macro").map((n) => [n.id, n.pos.x]));
    const spreadX = (desired: { key: string; x: number }[]): Map<string, { x: number; rank: number }> => {
      const out = new Map<string, { x: number; rank: number }>();
      const n = desired.length;
      if (!n) return out;
      const gap = Math.min(2.4, BAND_W / Math.max(1, n - 1));
      const sorted = [...desired].sort((a, b) => a.x - b.x);
      const xs = sorted.map((d) => d.x);
      for (let i = 1; i < n; i++) xs[i] = Math.max(xs[i], xs[i - 1] + gap); // 최소 간격 보장
      const mid = (xs[0] + xs[n - 1]) / 2;
      const span = xs[n - 1] - xs[0];
      const k = span > BAND_W ? BAND_W / span : 1; // 폭을 넘치면 전체를 눌러 담는다
      sorted.forEach((d, i) => out.set(d.key, { x: (xs[i] - mid) * k, rank: i }));
      return out;
    };
    const fallbackX = (i: number, n: number) => (n <= 1 ? 0 : (i / (n - 1) - 0.5) * BAND_W);

    if (state.verdict) {
      const vSectors = [...state.verdict.sectors.recommend, ...state.verdict.sectors.avoid];
      const sx = spreadX(
        vSectors.map((s, i) => {
          let wsum = 0;
          let xsum = 0;
          for (const e of s.edges) {
            const x = macroX.get(e.macroId);
            if (x === undefined || Math.abs(e.contribution) < 0.05) continue;
            const w = Math.abs(e.contribution);
            wsum += w;
            xsum += w * x;
          }
          return { key: s.sector, x: wsum ? xsum / wsum : fallbackX(i, vSectors.length) };
        }),
      );
      vSectors.forEach((s) => {
        const p = sx.get(s.sector)!;
        const pos = new THREE.Vector3(p.x, Y.sector + (p.rank % 2 ? 0.45 : -0.45), bandZ(p.x));
        this.addNode("sector", s.sector, s.sector, `${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)}`, pos, s.score);
      });
      for (const s of vSectors) {
        for (const e of s.edges) {
          if (Math.abs(e.contribution) < 0.05) continue;
          this.addEdge(e.macroId, "macro", s.sector, "sector", e.contribution);
        }
      }
      const vStocks = [...state.verdict.stocks.recommend, ...state.verdict.stocks.avoid];
      const tx = spreadX(
        vStocks.map((t, i) => ({
          // 종목은 자기 섹터 바로 아래에 — 같은 섹터 종목들은 spreadX 가 나란히 벌려 준다
          key: t.code,
          x: (t.sector ? sx.get(t.sector)?.x : undefined) ?? fallbackX(i, vStocks.length),
        })),
      );
      vStocks.forEach((t) => {
        const p = tx.get(t.code)!;
        const pos = new THREE.Vector3(p.x, Y.ticker + (p.rank % 2 ? 0.62 : -0.62), bandZ(p.x));
        this.addNode("ticker", t.code, t.name, t.score.toFixed(2), pos, t.score);
        if (t.sector && vSectors.some((s) => s.sector === t.sector)) {
          this.addEdge(t.sector, "sector", t.code, "ticker", t.score);
        }
      });
    } else {
      const sectorDefs = state.sectors ?? [];
      const sx = spreadX(
        sectorDefs.map((s, i) => {
          let wsum = 0;
          let xsum = 0;
          for (const [macroId, sens] of Object.entries(s.sensitivity)) {
            const m = macroById.get(macroId);
            const x = macroX.get(macroId);
            if (!m || x === undefined) continue;
            const w = Math.abs(sens * effVal(m));
            if (w < 0.12) continue;
            wsum += w;
            xsum += w * x;
          }
          return { key: s.sector, x: wsum ? xsum / wsum : fallbackX(i, sectorDefs.length) };
        }),
      );
      sectorDefs.forEach((s) => {
        const p = sx.get(s.sector)!;
        this.addNode("sector", s.sector, s.sector, "", new THREE.Vector3(p.x, Y.sector + (p.rank % 2 ? 0.45 : -0.45), bandZ(p.x)), 0);
      });
      for (const s of sectorDefs) {
        for (const [macroId, sens] of Object.entries(s.sensitivity)) {
          const m = macroById.get(macroId);
          if (!m) continue;
          const contribution = sens * effVal(m);
          if (Math.abs(contribution) < 0.12) continue;
          this.addEdge(macroId, "macro", s.sector, "sector", Math.round(contribution * 1000) / 1000);
        }
      }
    }

    // 거시 → 거시: 인과 링크. "지금 작동 중"(원인·결과가 부호대로 실제로 움직임)만
    // 진하게 + 펄스를 주고, 나머지는 흐린 점선로 구조만 남긴다.
    for (const l of state.macroLinks ?? []) {
      const from = macroById.get(l.from);
      const to = macroById.get(l.to);
      if (!from || !to) continue;
      const fv = effVal(from);
      const tv = effVal(to);
      const active = Math.abs(fv) >= 0.15 && Math.abs(tv) >= 0.1 && Math.sign(tv) === Math.sign(fv * l.sign);
      const contribution = l.sign * fv;
      const edge = this.addEdge(l.from, "macro", l.to, "macro", Math.round(contribution * 1000) / 1000, { dashed: true, arcUp: true });
      if (edge) edge.dim = !active;
    }

    if (keepSpot) this.showTicker(keepSpot);
    else if (this.countrySpot) this.showCountry(this.countrySpot.nameKo, this.countrySpot.items); // 데이터 갱신에도 나라 모드 유지
    else this.applyFocus();
  }

  /** 라벨의 화면 세로 크기를 LABEL_PX(css px)에 정확히 맞춘다 — 텍스처 해상도와 1:1 */
  private labelScaleY(kind: NodeKind, k = 1): number {
    return ((LABEL_PX[kind] * 2) / (PROJ11 * Math.max(1, this.hostH))) * k;
  }

  private applyLabelScale(sprite: THREE.Sprite, kind: NodeKind, k = 1): void {
    const sy = this.labelScaleY(kind, k);
    sprite.scale.set(sy * LABEL_ASPECT, sy, 1);
  }

  private addNode(kind: NodeKind, id: string, label: string, sub: string, pos: THREE.Vector3, tone: number): NodeObj {
    const color = kind === "sector" ? SECTOR_C.clone() : toneColor(tone);
    const sprite = labelSprite(label, sub, color, kind);
    this.applyLabelScale(sprite, kind);
    // 라벨을 살짝 위로 올려 점이 가려지지 않게 한다
    sprite.position.copy(pos).add(new THREE.Vector3(0, 0.3, 0));
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 16, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    dot.position.copy(pos);
    this.world.add(sprite, dot);
    const node: NodeObj = { kind, id, label, sub, pos, sprite, dot, tone };
    this.nodes.push(node);
    return node;
  }

  private addEdge(
    from: string,
    fromKind: NodeKind,
    to: string,
    toKind: NodeKind,
    contribution: number,
    opts?: { dashed?: boolean; arcUp?: boolean },
  ): EdgeObj | null {
    const a = this.nodes.find((n) => n.kind === fromKind && n.id === from);
    const b = this.nodes.find((n) => n.kind === toKind && n.id === to);
    if (!a || !b) return null;
    // 층간 간선은 세로로 떨어지는 S-곡선 — 출발점에서 수직으로 내려가 도착점 위로
    // 들어온다(산키 다이어그램 문법). 배리센터 정렬과 합쳐져 "위→아래 흐름"이 그대로 보인다.
    // 같은 층 안의 간선(거시→거시)은 위로 아치를 그려 층간 간선과 확실히 구분한다.
    let curve: THREE.Curve<THREE.Vector3>;
    if (opts?.arcUp) {
      const mid = a.pos.clone().add(b.pos).multiplyScalar(0.5);
      mid.y += 1.4;
      curve = new THREE.QuadraticBezierCurve3(a.pos.clone(), mid, b.pos.clone());
    } else {
      const drop = Math.max(1, Math.abs(a.pos.y - b.pos.y) * 0.45);
      curve = new THREE.CubicBezierCurve3(
        a.pos.clone(),
        a.pos.clone().add(new THREE.Vector3(0, -drop, 0.3)),
        b.pos.clone().add(new THREE.Vector3(0, drop, 0.3)),
        b.pos.clone(),
      );
    }
    const color = toneColor(contribution);
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28));
    const line = new THREE.Line(
      geo,
      opts?.dashed
        ? new THREE.LineDashedMaterial({
            color,
            transparent: true,
            opacity: 0.16 + Math.min(0.6, Math.abs(contribution) * 1.4),
            dashSize: 0.16,
            gapSize: 0.1,
          })
        : new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 0.16 + Math.min(0.6, Math.abs(contribution) * 1.4),
          }),
    );
    if (opts?.dashed) line.computeLineDistances();
    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 10, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
    this.world.add(line, pulse);
    const edge: EdgeObj = { from, to, fromKind, toKind, contribution, curve, line, pulse, phase: Math.random() };
    this.edges.push(edge);
    return edge;
  }

  /** 밝은/어두운 테마 전환 — 흐림 강도만 다시 계산한다 */
  setLightTheme(on: boolean): void {
    this.lightMode = on;
    this.applyFocus();
  }

  /** 노드 하나를 고르면 그와 이어진 경로만 남기고 나머지를 어둡게 한다 */
  setFocus(id: string | null): void {
    if (id === null) this.clearSpotlight();
    this.focus = id;
    this.applyFocus();
  }

  /** 나라 모드 — 온톨로지 유니버스(한국·미국) 밖 나라의 추천 종목을 무대에 얹는다 */
  private countrySpot: { nameKo: string; items: { symbol: string; name: string; score: number }[] } | null = null;

  showCountry(nameKo: string, items: { symbol: string; name: string; score: number }[]): void {
    this.clearSpotlight();
    this.focus = null;
    this.countrySpot = { nameKo, items: items.slice(0, 8) };
    const nodes: NodeObj[] = [];
    const edges: EdgeObj[] = [];
    const cid = `country:${nameKo}`;
    // 나라 칩은 섹터 밴드 정면 중앙 — 여기서 추천 종목으로 흘러내린다
    nodes.push(this.addNode("sector", cid, nameKo, "지수·뉴스 기반", new THREE.Vector3(0, Y.sector + 0.3, 1.0), 0));
    this.countrySpot.items.forEach((it, i) => {
      const x = (i - (this.countrySpot!.items.length - 1) / 2) * 2.3;
      nodes.push(this.addNode("ticker", it.symbol, it.name, it.score.toFixed(2), new THREE.Vector3(x, Y.ticker + (i % 2 ? 0.55 : -0.55), bandZ(x) + 0.6), it.score));
      const e = this.addEdge(cid, "sector", it.symbol, "ticker", it.score);
      if (e) edges.push(e);
    });
    this.spotlight = { ticker: { code: cid } as unknown as TickerNode, nodes, edges };
    this.applyFocus();
  }

  private clearSpotlight(): void {
    this.countrySpot = null;
    if (!this.spotlight) return;
    for (const n of this.spotlight.nodes) {
      this.world.remove(n.sprite, n.dot);
      (n.sprite.material as THREE.SpriteMaterial).map?.dispose();
      n.sprite.material.dispose();
    }
    for (const e of this.spotlight.edges) this.world.remove(e.line, e.pulse);
    this.nodes = this.nodes.filter((n) => !this.spotlight!.nodes.includes(n));
    this.edges = this.edges.filter((e) => !this.spotlight!.edges.includes(e));
    this.spotlight = null;
  }

  /**
   * 종목 하나에 조명을 켠다. 그래프는 |점수| 상위 24개만 상시 노드로 세우므로,
   * 검색·기회 탐색에서 고른 종목이 그래프에 없으면 그 종목 노드와
   * 거시 → 섹터 → 종목 경로를 임시로 꽂아 넣은 뒤 조명을 켠다.
   */
  showTicker(t: TickerNode): void {
    this.clearSpotlight();
    if (this.nodes.some((n) => n.kind === "ticker" && n.id === t.code)) {
      this.focus = t.code;
      this.applyFocus();
      return;
    }
    const nodes: NodeObj[] = [];
    const edges: EdgeObj[] = [];
    // 스포트라이트 종목은 종목 밴드 정면 중앙보다 살짝 앞(카메라 쪽)에 세운다
    nodes.push(this.addNode("ticker", t.code, t.nameKo, t.score.toFixed(2), new THREE.Vector3(0, Y.ticker - 0.3, 1.1), t.score));

    const tEdges = t.edges ?? [];
    const missingSectors = [...new Set(tEdges.map((e) => e.sector))].filter(
      (s) => !this.nodes.some((n) => n.kind === "sector" && n.id === s),
    );
    missingSectors.forEach((s, i) => {
      const x = (i - (missingSectors.length - 1) / 2) * 2.4;
      nodes.push(this.addNode("sector", s, s, "", new THREE.Vector3(x, Y.sector + 0.55, bandZ(x) + 0.5), 0));
    });
    const missingMacros = [...new Set(tEdges.map((e) => e.macroId))].filter(
      (id) => !this.nodes.some((n) => n.kind === "macro" && n.id === id),
    );
    missingMacros.forEach((id, i) => {
      const m = this.lastMacro.get(id);
      if (!m) return;
      const x = (i - (missingMacros.length - 1) / 2) * 2.4;
      nodes.push(
        this.addNode("macro", m.id, m.nameKo, `${m.changePct >= 0 ? "+" : ""}${m.changePct}%`, new THREE.Vector3(x, Y.macro + 0.5, bandZ(x) + 0.5), m.value),
      );
    });

    for (const e of tEdges) {
      const me = this.addEdge(e.macroId, "macro", e.sector, "sector", e.contribution);
      if (me) edges.push(me);
    }
    const stSeen = new Set<string>();
    for (const e of tEdges) {
      if (stSeen.has(e.sector)) continue;
      stSeen.add(e.sector);
      const se = this.addEdge(e.sector, "sector", t.code, "ticker", t.ontologyScore);
      if (se) edges.push(se);
    }

    this.spotlight = { ticker: t, nodes, edges };
    this.focus = t.code;
    this.applyFocus();
  }

  private connected(id: string): Set<string> {
    const start = this.nodes.find((n) => n.id === id);
    const keep = new Set<string>([id]);
    // 방향을 지킨다: 양방향으로 두 번 퍼뜨리면 이웃 섹터의 남 종목까지 다 밝아져
    // "이 종목의 경로"가 안 읽힌다.
    if (start?.kind === "ticker") {
      // 종목 → 그 종목을 만드는 경로만 거꾸로 (섹터, 그 섹터를 미는 거시)
      for (const e of this.edges) if (e.toKind === "ticker" && e.to === id) keep.add(e.from);
      for (const e of this.edges) if (e.toKind === "sector" && keep.has(e.to)) keep.add(e.from);
    } else if (start?.kind === "macro") {
      // 거시 → 그 힘이 흘러가는 곳만 앞으로 (섹터, 그 섹터의 종목)
      for (const e of this.edges) if (e.fromKind === "macro" && e.from === id) keep.add(e.to);
      for (const e of this.edges) if (e.fromKind === "sector" && keep.has(e.from)) keep.add(e.to);
    } else {
      // 섹터 → 위(거시)·아래(종목) 한 단계씩
      for (const e of this.edges) {
        if (e.from === id) keep.add(e.to);
        if (e.to === id) keep.add(e.from);
      }
    }
    return keep;
  }

  private applyFocus(): void {
    const keep = this.focus ? this.connected(this.focus) : null;
    /* 흐림·숨김(빼기) 방식은 전면 폐기 — 두 번 다 "흐릿하다"는 피드백(2026-08-17).
     * 모든 노드·간선은 포커스와 무관하게 항상 원래 밝기 그대로 두고,
     * 경로는 "더하기"로만 표시한다: 경로 간선은 더 진하게 + 펄스, 포커스 노드는 금색 후광. */
    for (const n of this.nodes) {
      n.sprite.visible = true;
      (n.sprite.material as THREE.SpriteMaterial).opacity = 1;
      const dm = n.dot.material as THREE.MeshBasicMaterial;
      dm.transparent = false;
      dm.opacity = 1;
    }
    for (const e of this.edges) {
      const onPath = keep !== null && keep.has(e.from) && keep.has(e.to);
      const boost = this.lightMode ? 0.24 : 0; // 밝은 배경에서 옅은 색 선은 연무처럼 보인다 — 진하게
      const base = e.dim ? 0.06 + boost : 0.16 + boost + Math.min(0.6, Math.abs(e.contribution) * 1.4);
      (e.line.material as THREE.LineBasicMaterial).opacity = onPath ? Math.min(1, base + 0.55) : base;
      // 펄스(흐르는 점)는 포커스 중엔 경로에만 — 시선을 경로로 모으되 나머지는 그대로 둔다
      (e.pulse.material as THREE.MeshBasicMaterial).opacity = e.dim ? 0 : keep ? (onPath ? 1 : 0) : 0.9;
    }

    // 후광 + 좌상단 정보 카드
    const node = this.focus ? this.nodes.find((n) => n.id === this.focus) : undefined;
    if (node) {
      if (!this.halo.parent) this.world.add(this.halo);
      this.halo.position.copy(node.pos);
      this.halo.visible = true;
      /* 가산 블렌딩은 밝은 배경에서 흰 번짐이 된다 — 라이트 모드는 일반 블렌딩으로 */
      const hm = this.halo.material as THREE.SpriteMaterial;
      hm.blending = this.lightMode ? THREE.NormalBlending : THREE.AdditiveBlending;
      hm.opacity = this.lightMode ? 0.6 : 0.9;
      hm.needsUpdate = true;
      this.opts.onFocus?.({
        id: node.id,
        kind: node.kind,
        label: node.label,
        sub: node.sub,
        degree: keep ? keep.size - 1 : 0,
      });
    } else {
      this.halo.visible = false;
      this.opts.onFocus?.(null);
    }
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.dragMoved = 0;
      this.last = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
      c.classList.add("dragging");
    });
    c.addEventListener("pointermove", (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.last.x;
        const dy = e.clientY - this.last.y;
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        // 계단식 밴드가 옆·뒤로 뒤집히지 않게 회전 범위를 좁게 잡는다
        this.rotY = Math.max(-0.5, Math.min(0.5, this.rotY + dx * 0.005));
        this.rotX = Math.max(-0.45, Math.min(0.2, this.rotX + dy * 0.004));
        this.last = { x: e.clientX, y: e.clientY };
        return;
      }
      const hit = this.pick(e);
      this.hoverId = hit?.id ?? null;
      c.style.cursor = hit ? "pointer" : "grab";
      this.opts.onHover(hit ? `${hit.label}${hit.sub ? ` · ${hit.sub}` : ""}` : null, e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (this.dragging && this.dragMoved < 6) {
        const hit = this.pick(e);
        if (hit) {
          this.setFocus(this.focus === hit.id ? null : hit.id);
          this.opts.onSelect(hit.kind, hit.id);
        } else {
          this.setFocus(null);
        }
      }
      this.dragging = false;
      c.classList.remove("dragging");
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", () => (this.dragging = false));
    c.addEventListener("pointerleave", () => {
      this.dragging = false;
      this.opts.onHover(null, 0, 0);
    });
    /* 휠 = 페이지 스크롤, Ctrl(⌘)+휠·트랙패드 핀치 = 확대.
     * 캔버스가 모든 휠을 preventDefault 로 잡으면 이 구획 위에서 페이지를
     * 내릴 수 없다(전략실이 캔버스 아래에 있을 때 아예 못 내려간다는 피드백). */
    c.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) {
          this.opts.onScrollHint?.();
          return; // 브라우저 기본 동작 = 페이지 스크롤
        }
        e.preventDefault();
        this.zoom(e.deltaY > 0 ? 0.9 : -0.9);
      },
      { passive: false },
    );
    window.addEventListener("resize", () => this.resize());
    if (typeof ResizeObserver !== "undefined" && c.parentElement) {
      new ResizeObserver(() => this.resize()).observe(c.parentElement);
    }
  }

  private pick(e: PointerEvent): NodeObj | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // 라벨을 숨긴(경로 밖) 노드는 픽 대상에서도 뺀다 — 안 보이는 걸 클릭되게 두면 혼란
    const visibleSprites = this.nodes.filter((n) => n.sprite.visible).map((n) => n.sprite);
    const hits = this.raycaster.intersectObjects(visibleSprites, false);
    if (!hits.length) return null;
    return this.nodes.find((n) => n.sprite === hits[0].object) ?? null;
  }

  zoom(delta: number): void {
    this.targetZoom = Math.max(9, Math.min(30, this.targetZoom + delta));
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on;
  }

  isAutoRotating(): boolean {
    return this.autoRotate;
  }

  /** E2E 진단용 */
  stats(): { frames: number; nodes: number; edges: number; calls: number } {
    return { frames: this.frames, nodes: this.nodes.length, edges: this.edges.length, calls: this.renderer.info.render.calls };
  }

  private resize(): void {
    const host = this.canvas.parentElement;
    const w = host?.clientWidth ?? 0;
    const h = host?.clientHeight ?? 0;
    if (!w || !h) return; // 숨겨진 상태에서 창 크기로 대체하면 종횡비가 오염된다
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.hostH = h;
    // 화면픽셀 고정 라벨 — 캔버스 높이가 바뀌면 전부 다시 맞춘다
    for (const s of this.bandDecor) this.applyLabelScale(s, "macro");
    for (const s of this.captions) this.applyLabelScale(s, "sector");
  }

  private animate = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, this.clock.getDelta());

    // 계단식 밴드는 한 바퀴 돌 이유가 없다 — 좌우로 천천히 흔들리는 시차(패럴랙스)만 준다
    if (this.autoRotate && !this.dragging && !this.reducedMotion) {
      this.swayT += dt;
      this.rotY += (Math.sin(this.swayT * 0.22) * 0.14 - this.rotY) * 0.03;
    }
    this.world.rotation.y = this.rotY;
    this.world.rotation.x = this.rotX;
    this.camera.position.z += (this.targetZoom - this.camera.position.z) * 0.1;

    // 신호가 흐르는 방향으로 점을 굴린다. 음수 기여도는 반대로 흐른다.
    for (const e of this.edges) {
      const speed = 0.12 + Math.min(0.5, Math.abs(e.contribution) * 1.1);
      e.phase = (e.phase + dt * speed * (this.reducedMotion ? 0 : 1)) % 1;
      const t = e.contribution >= 0 ? e.phase : 1 - e.phase;
      e.pulse.position.copy(e.curve.getPoint(t));
    }

    // 마우스가 올라간 노드·포커스 노드는 살짝 커진다 (강조는 더하기로만)
    for (const n of this.nodes) {
      const k = n.id === this.hoverId ? 1.18 : n.id === this.focus ? 1.12 : 1;
      const sy = this.labelScaleY(n.kind, k);
      n.sprite.scale.x += (sy * LABEL_ASPECT - n.sprite.scale.x) * 0.2;
      n.sprite.scale.y += (sy - n.sprite.scale.y) * 0.2;
    }

    // 포커스 후광 맥동
    if (this.halo.visible) {
      this.haloT += dt;
      const pulse = this.reducedMotion ? 1 : 1 + Math.sin(this.haloT * 2.4) * 0.1;
      const base = 0.135 * pulse;
      this.halo.scale.set(base, base, 1);
    }

    this.renderer.render(this.scene, this.camera);
    this.frames++;
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
  }
}
