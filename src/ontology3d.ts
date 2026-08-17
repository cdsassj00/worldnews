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
  curve: THREE.QuadraticBezierCurve3;
  line: THREE.Line;
  pulse: THREE.Mesh;
  phase: number;
  /** 지금 작동하지 않는 인과 링크 — 구조만 흐리게 남긴다 */
  dim?: boolean;
}

const RING = { macro: 3.2, sector: 4.9, ticker: 6.9 };
const Y = { macro: 2.8, sector: 0, ticker: -2.8 };

/**
 * 라벨 크기는 화면 기준으로 고정한다(sizeAttenuation=false).
 * 원근으로 크기가 변하면 앞쪽 노드가 화면을 다 덮어 그래프를 읽을 수 없다.
 */
/* 2026-08-17 "폰트가 너무 커서 가독성이 나쁘다" 피드백 — 칩을 한 단계 줄인다.
 * 줄일수록 노드가 많이 보이고 겹침이 줄어 오히려 잘 읽힌다. */
const LABEL: Record<NodeKind, { x: number; y: number }> = {
  macro: { x: 0.104, y: 0.0325 },
  sector: { x: 0.082, y: 0.0256 },
  ticker: { x: 0.093, y: 0.029 },
};

const UP = new THREE.Color("#f87171");
const DOWN = new THREE.Color("#60a5fa");
const FLAT = new THREE.Color("#64748b");
const SECTOR_C = new THREE.Color("#94a3b8");

function toneColor(tone: number): THREE.Color {
  if (Math.abs(tone) < 0.04) return FLAT.clone();
  const target = tone > 0 ? UP : DOWN;
  return FLAT.clone().lerp(target, Math.min(1, Math.abs(tone) * 1.6 + 0.35));
}

/** 라벨 스프라이트 (캔버스로 그려 항상 카메라를 향하게 한다) */
function labelSprite(title: string, sub: string, color: THREE.Color, kind: NodeKind): THREE.Sprite {
  const W = 512;
  const H = 160;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  const hex = `#${color.getHexString()}`;

  /* 유리판 칩 — 진한 남색 유리 + 색상 테두리.
   * 칩마다 넣던 색 글로우(shadowBlur)는 제거: 수십 개가 겹치면 밝은 배경에서
   * 붉은 연무가 되어 "흐리다"는 인상의 주범이었다(2026-08-17 실측). */
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(17,27,50,0.94)");
  grad.addColorStop(1, "rgba(7,12,26,0.9)");
  ctx.fillStyle = grad;
  ctx.strokeStyle = hex;
  ctx.lineWidth = 3.5;
  // 알약(pill) — 2026-08-17 "라벨 동그랗게 + 테두리" 피드백
  const r = (H - 8) / 2;
  ctx.beginPath();
  ctx.roundRect(4, 4, W - 8, H - 8, r);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 왼쪽 계층 색 점 — 참고 디자인의 노드 점 문법
  ctx.fillStyle = hex;
  ctx.beginPath();
  ctx.arc(52, H / 2, 13, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f8fafc";
  ctx.font = "700 46px Pretendard, system-ui, sans-serif";
  ctx.fillText(title, W / 2 + 8, sub ? H / 2 - 20 : H / 2, W - 72);
  if (sub) {
    ctx.fillStyle = hex;
    ctx.font = "600 34px 'Fira Code', ui-monospace, monospace";
    ctx.fillText(sub, W / 2 + 8, H / 2 + 32, W - 72);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false }),
  );
  sprite.scale.set(LABEL[kind].x, LABEL[kind].y, 1);
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
  private rotY = 0.35;
  private rotX = -0.18;
  private targetZoom = 16.5;
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
    this.scene.add(new THREE.AmbientLight(0xdbeafe, 1.2));
    this.buildRings();
    this.bindEvents();
    this.resize();
    this.animate();
  }

  /** 층을 눈으로 구분해 주는 얇은 고리 */
  private buildRings(): void {
    for (const [key, radius] of Object.entries(RING) as [keyof typeof RING, number][]) {
      const geo = new THREE.RingGeometry(radius - 0.012, radius + 0.012, 128);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0x1e3a5f, transparent: true, opacity: 0.75, side: THREE.DoubleSide }),
      );
      mesh.rotation.x = Math.PI / 2;
      mesh.position.y = Y[key];
      this.world.add(mesh);
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

    const place = (i: number, n: number, radius: number, y: number) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius);
    };

    ordered.forEach(({ m }, i) => {
      // 클러스터 경계마다 라벨 높이를 엇갈려 이웃 겹침을 줄인다
      const pos = place(i, ordered.length, RING.macro, Y.macro + (i % 2 ? 0.5 : 0));
      this.addNode("macro", m.id, m.nameKo, `${m.changePct >= 0 ? "+" : ""}${m.changePct}%`, pos, m.value);
    });
    // 클러스터 캡션 (픽 대상이 아니므로 nodes 에 넣지 않는다)
    clusters.forEach((c, ci) => {
      const idxs = ordered.map((o, i) => (o.cluster === ci ? i : -1)).filter((i) => i >= 0);
      if (!idxs.length || !c.nameKo) return;
      const mid = (idxs[0] + idxs[idxs.length - 1]) / 2;
      const a = (mid / ordered.length) * Math.PI * 2;
      const sprite = labelSprite(`⟨ ${c.nameKo} ⟩`, "", SECTOR_C.clone(), "sector");
      sprite.position.set(Math.cos(a) * (RING.macro + 1.0), Y.macro + 1.35, Math.sin(a) * (RING.macro + 1.0));
      sprite.material.opacity = 1; // 반투명 금지 — 흐릿함 피드백
      this.world.add(sprite);
      this.captions.push(sprite);
    });

    /* 가운데·아래 층 = 결론의 시각화.
     * 결론(verdict)이 있으면: 추천/회피에 오른 섹터와 종목만 세운다 — 그래프가
     * "온톨로지 분석 결과 이런 섹터·이런 종목"을 그대로 보여주는 화면이 된다.
     * 결론이 아직 없으면(로딩 초기): 민감도 표 기반 폴백. */
    if (state.verdict) {
      const vSectors = [...state.verdict.sectors.recommend, ...state.verdict.sectors.avoid];
      vSectors.forEach((s, i) => {
        this.addNode("sector", s.sector, s.sector, `${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)}`, place(i, vSectors.length, RING.sector, Y.sector + (i % 2 ? 0.45 : -0.45)), s.score);
      });
      for (const s of vSectors) {
        for (const e of s.edges) {
          if (Math.abs(e.contribution) < 0.05) continue;
          this.addEdge(e.macroId, "macro", s.sector, "sector", e.contribution);
        }
      }
      const vStocks = [...state.verdict.stocks.recommend, ...state.verdict.stocks.avoid];
      vStocks.forEach((t, i) => {
        const pos = place(i, vStocks.length, RING.ticker, Y.ticker + (i % 2 ? 0.62 : -0.62));
        this.addNode("ticker", t.code, t.name, t.score.toFixed(2), pos, t.score);
        if (t.sector && vSectors.some((s) => s.sector === t.sector)) {
          this.addEdge(t.sector, "sector", t.code, "ticker", t.score);
        }
      });
    } else {
      const sectorDefs = state.sectors ?? [];
      sectorDefs.forEach((s, i) => {
        this.addNode("sector", s.sector, s.sector, "", place(i, sectorDefs.length, RING.sector, Y.sector + (i % 2 ? 0.45 : -0.45)), 0);
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
    else this.applyFocus();
  }

  private addNode(kind: NodeKind, id: string, label: string, sub: string, pos: THREE.Vector3, tone: number): NodeObj {
    const color = kind === "sector" ? SECTOR_C.clone() : toneColor(tone);
    const sprite = labelSprite(label, sub, color, kind);
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
    // 가운데를 안쪽으로 당겨 고리 사이를 지나가게 한다(직선이면 라벨을 뚫는다).
    // 같은 고리 안의 간선(거시→거시)은 위로 아치를 그려 층간 간선과 구분한다.
    const mid = a.pos.clone().add(b.pos).multiplyScalar(0.5).multiplyScalar(opts?.arcUp ? 0.8 : 0.62);
    if (opts?.arcUp) mid.y += 1.5;
    const curve = new THREE.QuadraticBezierCurve3(a.pos.clone(), mid, b.pos.clone());
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

  private clearSpotlight(): void {
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
    const baseA = -0.5;
    const at = (radius: number, y: number, a: number) => new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius);

    nodes.push(this.addNode("ticker", t.code, t.nameKo, t.score.toFixed(2), at(RING.ticker + 0.5, Y.ticker + 0.95, baseA), t.score));

    const tEdges = t.edges ?? [];
    const missingSectors = [...new Set(tEdges.map((e) => e.sector))].filter(
      (s) => !this.nodes.some((n) => n.kind === "sector" && n.id === s),
    );
    missingSectors.forEach((s, i) => {
      nodes.push(this.addNode("sector", s, s, "", at(RING.sector + 0.4, Y.sector + 0.5, baseA + (i - (missingSectors.length - 1) / 2) * 0.3), 0));
    });
    const missingMacros = [...new Set(tEdges.map((e) => e.macroId))].filter(
      (id) => !this.nodes.some((n) => n.kind === "macro" && n.id === id),
    );
    missingMacros.forEach((id, i) => {
      const m = this.lastMacro.get(id);
      if (!m) return;
      nodes.push(
        this.addNode("macro", m.id, m.nameKo, `${m.changePct >= 0 ? "+" : ""}${m.changePct}%`, at(RING.macro + 0.4, Y.macro + 0.4, baseA + (i - (missingMacros.length - 1) / 2) * 0.28), m.value),
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
        this.rotY += dx * 0.005;
        this.rotX = Math.max(-0.9, Math.min(0.9, this.rotX + dy * 0.004));
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
  }

  private animate = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, this.clock.getDelta());

    if (this.autoRotate && !this.dragging && !this.reducedMotion) this.rotY += dt * 0.09;
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
      n.sprite.scale.x += (LABEL[n.kind].x * k - n.sprite.scale.x) * 0.2;
      n.sprite.scale.y += (LABEL[n.kind].y * k - n.sprite.scale.y) * 0.2;
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
