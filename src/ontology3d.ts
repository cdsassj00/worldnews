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
}

export interface Onto3DOptions {
  onSelect: (kind: "macro" | "sector" | "ticker", id: string) => void;
  onHover: (label: string | null, x: number, y: number) => void;
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
}

const RING = { macro: 3.2, sector: 4.9, ticker: 6.9 };
const Y = { macro: 2.8, sector: 0, ticker: -2.8 };

/**
 * 라벨 크기는 화면 기준으로 고정한다(sizeAttenuation=false).
 * 원근으로 크기가 변하면 앞쪽 노드가 화면을 다 덮어 그래프를 읽을 수 없다.
 */
const LABEL: Record<NodeKind, { x: number; y: number }> = {
  macro: { x: 0.125, y: 0.039 },
  sector: { x: 0.1, y: 0.031 },
  ticker: { x: 0.112, y: 0.035 },
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

  ctx.fillStyle = "rgba(9,15,28,0.88)";
  ctx.strokeStyle = hex;
  ctx.lineWidth = 4;
  const r = 22;
  ctx.beginPath();
  ctx.roundRect(4, 4, W - 8, H - 8, r);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f8fafc";
  ctx.font = "600 52px Pretendard, system-ui, sans-serif";
  ctx.fillText(title, W / 2, sub ? H / 2 - 18 : H / 2, W - 40);
  if (sub) {
    ctx.fillStyle = hex;
    ctx.font = "500 38px 'Fira Code', ui-monospace, monospace";
    ctx.fillText(sub, W / 2, H / 2 + 32, W - 40);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false }),
  );
  sprite.scale.set(LABEL[kind].x, LABEL[kind].y, 1);
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
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private clock = new THREE.Clock();
  private frames = 0;

  /** 그래프 상시 노드가 아닌 종목을 골랐을 때 임시로 꽂아 넣은 노드·간선 */
  private spotlight: { ticker: TickerNode; nodes: NodeObj[]; edges: EdgeObj[] } | null = null;
  private lastMacro = new Map<string, MacroNode>();

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
    this.nodes = [];
    this.edges = [];
    this.spotlight = null;

    const macroById = new Map(state.macro.map((m) => [m.id, m]));

    // 유니버스가 커져(≈90) 전부 그리면 읽을 수 없다. |점수| 상위 24개만 노드로 세운다.
    // 나머지는 좌측 목록·검색으로 접근한다 — 그래프는 "지금 신호가 강한 곳"을 보여주는 화면이다.
    const shown = state.scores
      .filter((t) => (t.edges ?? []).length > 0)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 24);
    const live = shown.flatMap((t) => (t.edges ?? []).map((e) => ({ ...e, code: t.code })));
    const sectors = [...new Set(live.map((e) => e.sector))];
    const macroIds = [...new Set(live.map((e) => e.macroId))];
    const tickers = shown;

    const place = (i: number, n: number, radius: number, y: number) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius);
    };

    macroIds.forEach((id, i) => {
      const m = macroById.get(id);
      if (!m) return;
      this.addNode("macro", id, m.nameKo, `${m.changePct >= 0 ? "+" : ""}${m.changePct}%`, place(i, macroIds.length, RING.macro, Y.macro), m.value);
    });
    sectors.forEach((s, i) => {
      this.addNode("sector", s, s, "", place(i, sectors.length, RING.sector, Y.sector), 0);
    });
    // 이웃끼리 라벨이 겹치지 않게 한 칸씩 높이를 엇갈린다
    tickers.forEach((t, i) => {
      const pos = place(i, tickers.length, RING.ticker, Y.ticker + (i % 2 ? 0.62 : -0.62));
      this.addNode("ticker", t.code, t.nameKo, t.score.toFixed(2), pos, t.score);
    });

    // 같은 (거시,섹터) 쌍이 여러 종목에서 반복되므로 합쳐서 한 번만 그린다
    const msSeen = new Map<string, number>();
    for (const e of live) {
      const k = `${e.macroId}|${e.sector}`;
      msSeen.set(k, Math.abs(e.contribution) > Math.abs(msSeen.get(k) ?? 0) ? e.contribution : msSeen.get(k)!);
    }
    for (const [k, contribution] of msSeen) {
      const [macroId, sector] = k.split("|");
      this.addEdge(macroId, "macro", sector, "sector", contribution);
    }
    const stSeen = new Set<string>();
    for (const e of live) {
      const k = `${e.sector}|${e.code}`;
      if (stSeen.has(k)) continue;
      stSeen.add(k);
      const t = shown.find((x) => x.code === e.code);
      this.addEdge(e.sector, "sector", e.code, "ticker", t?.ontologyScore ?? 0);
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

  private addEdge(from: string, fromKind: NodeKind, to: string, toKind: NodeKind, contribution: number): EdgeObj | null {
    const a = this.nodes.find((n) => n.kind === fromKind && n.id === from);
    const b = this.nodes.find((n) => n.kind === toKind && n.id === to);
    if (!a || !b) return null;
    // 가운데를 안쪽으로 당겨 고리 사이를 지나가게 한다(직선이면 라벨을 뚫는다)
    const mid = a.pos.clone().add(b.pos).multiplyScalar(0.5).multiplyScalar(0.62);
    const curve = new THREE.QuadraticBezierCurve3(a.pos.clone(), mid, b.pos.clone());
    const color = toneColor(contribution);
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28));
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.16 + Math.min(0.6, Math.abs(contribution) * 1.4),
      }),
    );
    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 10, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
    this.world.add(line, pulse);
    const edge: EdgeObj = { from, to, fromKind, toKind, contribution, curve, line, pulse, phase: Math.random() };
    this.edges.push(edge);
    return edge;
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
    for (const n of this.nodes) {
      const on = !keep || keep.has(n.id);
      (n.sprite.material as THREE.SpriteMaterial).opacity = on ? 1 : 0.12;
      (n.dot.material as THREE.MeshBasicMaterial).opacity = on ? 1 : 0.12;
      (n.dot.material as THREE.MeshBasicMaterial).transparent = true;
    }
    for (const e of this.edges) {
      const on = !keep || (keep.has(e.from) && keep.has(e.to));
      const base = 0.16 + Math.min(0.6, Math.abs(e.contribution) * 1.4);
      (e.line.material as THREE.LineBasicMaterial).opacity = on ? base : 0.03;
      (e.pulse.material as THREE.MeshBasicMaterial).opacity = on ? 0.9 : 0.05;
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
    c.addEventListener(
      "wheel",
      (e) => {
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
    const hits = this.raycaster.intersectObjects(this.nodes.map((n) => n.sprite), false);
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

    // 마우스가 올라간 노드는 살짝 커진다
    for (const n of this.nodes) {
      const k = n.id === this.hoverId ? 1.18 : 1;
      n.sprite.scale.x += (LABEL[n.kind].x * k - n.sprite.scale.x) * 0.2;
      n.sprite.scale.y += (LABEL[n.kind].y * k - n.sprite.scale.y) * 0.2;
    }

    this.renderer.render(this.scene, this.camera);
    this.frames++;
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
  }
}
