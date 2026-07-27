/**
 * 3D 지구본.
 *
 * 국가 판정은 폴리곤 지오메트리 대신 "픽 텍스처" 방식을 쓴다.
 *  - 시각용 텍스처(바다/육지/국경)와 동일한 등장방형(equirectangular) 좌표계에
 *    국가마다 고유 색을 칠한 픽 캔버스를 하나 더 만든다.
 *  - 클릭 시 레이캐스트로 얻은 uv → 픽 캔버스 픽셀 → 국가 ID.
 * 덕분에 175개국을 개별 메시로 만들지 않아도 정확히 집을 수 있다.
 *
 * 좌표 규약은 THREE.SphereGeometry 의 UV 매핑과 정확히 일치시켰다.
 *   u = (lon+180)/360,  canvasY = (90-lat)/180 * H
 */
import * as THREE from "three";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countryMeta from "./data/generated/countries.json";

export interface CountryRef {
  id: string;
  iso2: string | null;
  ko: string;
  en: string;
  lon: number;
  lat: number;
}

type Meta = Record<string, { iso2: string | null; ko: string; en: string; lon: number; lat: number }>;

const META = countryMeta as Meta;

export interface GlobeOptions {
  /** 시장 데이터가 있는 국가(초록 마커) */
  liveCodes: Set<string>;
  /** 한국투자증권 주문 가능 국가(앰버 마커) */
  orderCodes: Set<string>;
  onSelect: (c: CountryRef) => void;
  onHover: (c: CountryRef | null, clientX: number, clientY: number) => void;
}

const BASE_W = 4096;
const BASE_H = 2048;
const PICK_W = 2048;
const PICK_H = 1024;

const COLOR = {
  oceanTop: "#08152c",
  oceanBottom: "#050c1c",
  land: "#17253c",
  landLive: "#1d3252",
  border: "#2e4667",
  graticule: "rgba(148, 197, 255, 0.05)",
};

function lonLatToVector3(lon: number, lat: number, radius: number): THREE.Vector3 {
  const u = (lon + 180) / 360;
  const v = (90 - lat) / 180;
  const phi = u * Math.PI * 2;
  const theta = v * Math.PI;
  return new THREE.Vector3(
    -radius * Math.cos(phi) * Math.sin(theta),
    radius * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/** 경도 → 캔버스 x, 위도 → 캔버스 y */
function project(lon: number, lat: number, w: number, h: number): [number, number] {
  return [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
}

/** GeoJSON Polygon/MultiPolygon 을 캔버스 경로로 그린다(날짜변경선 분할 처리 포함) */
function tracePath(ctx: CanvasRenderingContext2D, geometry: GeoJSON.Geometry, w: number, h: number): void {
  const polys: number[][][][] =
    geometry.type === "Polygon"
      ? [(geometry as GeoJSON.Polygon).coordinates as number[][][]]
      : geometry.type === "MultiPolygon"
        ? ((geometry as GeoJSON.MultiPolygon).coordinates as number[][][][])
        : [];

  for (const poly of polys) {
    for (const ring of poly) {
      if (ring.length < 2) continue;

      // 날짜변경선(±180°)을 넘는 나라(러시아·피지 등)를 그대로 그리면
      // 경도가 +179 → -179 로 튀면서 지도를 가로지르는 가짜 선이 생긴다.
      // 링을 잘라 각각 닫으면 그 조각을 닫는 직선이 또 대륙을 가로지른다.
      // 그래서 자르지 않고 경도를 "펴서"(unwrap) 연속되게 만든 뒤,
      // 화면 밖으로 나간 부분은 ±360° 만큼 옮겨 한 번 더 그린다.
      const unwrapped: number[][] = [];
      let offset = 0;
      let prevLon = ring[0][0];
      for (const [lon, lat] of ring) {
        const delta = lon - prevLon;
        if (delta > 180) offset -= 360;
        else if (delta < -180) offset += 360;
        prevLon = lon;
        unwrapped.push([lon + offset, lat]);
      }

      let minLon = Infinity;
      let maxLon = -Infinity;
      for (const [lon] of unwrapped) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }

      // 기본 위치 + 필요하면 반대편에 한 번 더(날짜변경선 양쪽 모두 채우기)
      const shifts = [0];
      if (minLon < -180) shifts.push(360);
      if (maxLon > 180) shifts.push(-360);

      for (const shift of shifts) {
        ctx.moveTo(...project(unwrapped[0][0] + shift, unwrapped[0][1], w, h));
        for (let i = 1; i < unwrapped.length; i++) {
          ctx.lineTo(...project(unwrapped[i][0] + shift, unwrapped[i][1], w, h));
        }
        ctx.closePath();
      }
    }
  }
}

function idToColor(index: number): string {
  const n = index + 1;
  return `rgb(${n & 255},${(n >> 8) & 255},0)`;
}

function colorToIndex(r: number, g: number): number {
  return (r | (g << 8)) - 1;
}

function circleTexture(color: string, soft = true): THREE.Texture {
  const size = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, color);
  grad.addColorStop(soft ? 0.45 : 0.85, color);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Globe {
  private canvas: HTMLCanvasElement;
  private opts: GlobeOptions;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private group = new THREE.Group();
  private earth!: THREE.Mesh;
  private overlay!: THREE.Mesh;
  private overlayCtx!: CanvasRenderingContext2D;
  private overlayTexture!: THREE.CanvasTexture;
  private pickCtx!: CanvasRenderingContext2D;
  private features: GeoJSON.Feature[] = [];
  private refs: CountryRef[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private autoRotate = true;
  private dragging = false;
  private dragMoved = 0;
  private lastPointer = { x: 0, y: 0 };
  // 카메라를 멀리 둘수록 지구본이 작게 보인다. 화면을 꽉 채우면 답답해서 여백을 준다.
  private targetZoom = 4.2;
  private hoverIndex = -1;
  private selectedIndex = -1;
  private flying: { fromX: number; fromY: number; toX: number; toY: number; t: number; dur: number } | null = null;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, opts: GlobeOptions) {
    this.canvas = canvas;
    this.opts = opts;
  }

  get countries(): CountryRef[] {
    return this.refs;
  }

  async init(): Promise<void> {
    const topo = (await fetch("/data/countries-110m.json").then((r) => {
      if (!r.ok) throw new Error(`지도 데이터 로드 실패 (${r.status})`);
      return r.json();
    })) as Topology<{ countries: GeometryCollection }>;
    const geo = feature(topo, topo.objects.countries) as unknown as GeoJSON.FeatureCollection;
    this.features = geo.features;
    this.refs = this.features.map((f) => {
      const m = META[String(f.id)] ?? { iso2: null, ko: String(f.properties?.name ?? ""), en: String(f.properties?.name ?? ""), lon: 0, lat: 0 };
      return { id: String(f.id), iso2: m.iso2, ko: m.ko, en: m.en, lon: m.lon, lat: m.lat };
    });

    this.buildRenderer();
    this.buildEarth();
    this.buildAtmosphere();
    this.buildStars();
    this.buildMarkers();
    this.bindEvents();
    this.animate();
  }

  private buildRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.camera.position.set(0, 0, this.targetZoom);
    this.group.rotation.order = "XYZ";
    this.scene.add(this.group);
    this.scene.add(new THREE.AmbientLight(0xa8c4ff, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(-1.4, 0.9, 2.2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x3b82f6, 0.5);
    rim.position.set(2.2, -0.6, -1.4);
    this.scene.add(rim);
    this.resize();
  }

  private buildEarth(): void {
    // 시각 텍스처
    const base = document.createElement("canvas");
    base.width = BASE_W;
    base.height = BASE_H;
    const ctx = base.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, BASE_H);
    grad.addColorStop(0, COLOR.oceanBottom);
    grad.addColorStop(0.5, COLOR.oceanTop);
    grad.addColorStop(1, COLOR.oceanBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, BASE_W, BASE_H);

    // 경위선
    ctx.strokeStyle = COLOR.graticule;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 30) {
      const [x] = project(lon, 0, BASE_W, BASE_H);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, BASE_H);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [, y] = project(0, lat, BASE_W, BASE_H);
      ctx.moveTo(0, y);
      ctx.lineTo(BASE_W, y);
    }
    ctx.stroke();

    // 육지 + 국경
    this.features.forEach((f, i) => {
      const iso2 = this.refs[i]?.iso2 ?? "";
      const live = iso2 ? this.opts.liveCodes.has(iso2) : false;
      ctx.beginPath();
      tracePath(ctx, f.geometry, BASE_W, BASE_H);
      ctx.fillStyle = live ? COLOR.landLive : COLOR.land;
      ctx.fill();
      ctx.strokeStyle = COLOR.border;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    });

    const baseTex = new THREE.CanvasTexture(base);
    baseTex.colorSpace = THREE.SRGBColorSpace;
    baseTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.earth = new THREE.Mesh(
      new THREE.SphereGeometry(1, 128, 72),
      new THREE.MeshPhongMaterial({ map: baseTex, shininess: 6, specular: new THREE.Color(0x16273f) }),
    );
    this.group.add(this.earth);

    // 픽 텍스처(화면에 그리지 않음)
    const pick = document.createElement("canvas");
    pick.width = PICK_W;
    pick.height = PICK_H;
    const pctx = pick.getContext("2d", { willReadFrequently: true })!;
    pctx.imageSmoothingEnabled = false;
    pctx.fillStyle = "#000000";
    pctx.fillRect(0, 0, PICK_W, PICK_H);
    this.features.forEach((f, i) => {
      const color = idToColor(i);
      pctx.beginPath();
      tracePath(pctx, f.geometry, PICK_W, PICK_H);
      pctx.fillStyle = color;
      pctx.fill();
      // 작은 섬·좁은 국가도 집히도록 외곽선까지 같은 색으로 두껍게
      pctx.strokeStyle = color;
      pctx.lineWidth = 1.6;
      pctx.stroke();
    });
    this.pickCtx = pctx;

    // 하이라이트 오버레이
    const ov = document.createElement("canvas");
    ov.width = PICK_W;
    ov.height = PICK_H;
    this.overlayCtx = ov.getContext("2d")!;
    this.overlayTexture = new THREE.CanvasTexture(ov);
    this.overlayTexture.colorSpace = THREE.SRGBColorSpace;
    this.overlay = new THREE.Mesh(
      new THREE.SphereGeometry(1.0025, 128, 72),
      new THREE.MeshBasicMaterial({ map: this.overlayTexture, transparent: true, depthWrite: false }),
    );
    this.group.add(this.overlay);
  }

  private buildAtmosphere(): void {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(0x2f6fd0) } },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying vec3 vNormal;
        void main() {
          float intensity = pow(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.2);
          gl_FragColor = vec4(uColor, 1.0) * intensity;
        }`,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.22, 64, 40), material));
  }

  private buildStars(): void {
    const count = 1400;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 14 + Math.random() * 10;
      const theta = Math.acos(2 * Math.random() - 1);
      const phi = Math.random() * Math.PI * 2;
      positions[i * 3] = r * Math.sin(theta) * Math.cos(phi);
      positions[i * 3 + 1] = r * Math.cos(theta);
      positions[i * 3 + 2] = r * Math.sin(theta) * Math.sin(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.scene.add(
      new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fb6d6, size: 0.09, transparent: true, opacity: 0.75 })),
    );
  }

  private markerPulse: THREE.Points[] = [];

  private buildMarkers(): void {
    const live: number[] = [];
    const order: number[] = [];
    for (const ref of this.refs) {
      if (!ref.iso2) continue;
      const v = lonLatToVector3(ref.lon, ref.lat, 1.012);
      if (this.opts.orderCodes.has(ref.iso2)) order.push(v.x, v.y, v.z);
      else if (this.opts.liveCodes.has(ref.iso2)) live.push(v.x, v.y, v.z);
    }
    const make = (arr: number[], color: string, size: number) => {
      if (!arr.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(arr), 3));
      const mat = new THREE.PointsMaterial({
        size,
        map: circleTexture(color),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      });
      const pts = new THREE.Points(geo, mat);
      this.group.add(pts);
      this.markerPulse.push(pts);
      return pts;
    };
    make(live, "rgba(34,197,94,0.95)", 0.045);
    make(order, "rgba(251,191,36,0.98)", 0.055);
  }

  /* ── 상호작용 ─────────────────────────────── */

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.dragMoved = 0;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      c.classList.add("dragging");
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        this.group.rotation.y += dx * 0.005;
        this.group.rotation.x = THREE.MathUtils.clamp(this.group.rotation.x + dy * 0.005, -1.2, 1.2);
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.flying = null;
      } else {
        const hit = this.pickAt(e.clientX, e.clientY);
        const idx = hit?.index ?? -1;
        if (idx !== this.hoverIndex) {
          this.hoverIndex = idx;
          this.drawOverlay();
        }
        this.opts.onHover(idx >= 0 ? this.refs[idx] : null, e.clientX, e.clientY);
      }
    });
    const endDrag = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      c.classList.remove("dragging");
      if (this.dragMoved < 6) {
        const hit = this.pickAt(e.clientX, e.clientY);
        if (hit) this.select(hit.index);
      }
    };
    c.addEventListener("pointerup", endDrag);
    c.addEventListener("pointercancel", () => {
      this.dragging = false;
      c.classList.remove("dragging");
    });
    c.addEventListener("pointerleave", () => {
      this.hoverIndex = -1;
      this.drawOverlay();
      this.opts.onHover(null, 0, 0);
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom(e.deltaY > 0 ? 0.22 : -0.22);
      },
      { passive: false },
    );
    window.addEventListener("resize", () => this.resize());
  }

  private pickAt(clientX: number, clientY: number): { index: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.earth, false);
    const uv = hits[0]?.uv;
    if (!uv) return null;
    const x = Math.floor(uv.x * PICK_W);
    const y = Math.floor((1 - uv.y) * PICK_H);
    // 국경에서 안티에일리어싱으로 색이 섞이므로 3x3 최다득표로 판정
    const votes = new Map<number, number>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.min(PICK_W - 1, Math.max(0, x + dx));
        const py = Math.min(PICK_H - 1, Math.max(0, y + dy));
        const d = this.pickCtx.getImageData(px, py, 1, 1).data;
        if (d[0] === 0 && d[1] === 0) continue;
        const idx = colorToIndex(d[0], d[1]);
        if (idx < 0 || idx >= this.refs.length) continue;
        votes.set(idx, (votes.get(idx) ?? 0) + (dx === 0 && dy === 0 ? 3 : 1));
      }
    }
    if (!votes.size) return null;
    let bestIdx = -1;
    let bestVotes = 0;
    for (const [idx, v] of votes) {
      if (v > bestVotes) {
        bestVotes = v;
        bestIdx = idx;
      }
    }
    return bestIdx >= 0 ? { index: bestIdx } : null;
  }

  private drawOverlay(): void {
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, PICK_W, PICK_H);
    const paint = (index: number, fill: string, stroke: string, width: number) => {
      const f = this.features[index];
      if (!f) return;
      ctx.beginPath();
      tracePath(ctx, f.geometry, PICK_W, PICK_H);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    if (this.hoverIndex >= 0 && this.hoverIndex !== this.selectedIndex) {
      paint(this.hoverIndex, "rgba(56,189,248,0.22)", "rgba(125,211,252,0.85)", 1.6);
    }
    if (this.selectedIndex >= 0) {
      paint(this.selectedIndex, "rgba(34,197,94,0.3)", "rgba(134,239,172,0.95)", 2.2);
    }
    this.overlayTexture.needsUpdate = true;
  }

  select(index: number): void {
    if (index < 0 || index >= this.refs.length) return;
    this.selectedIndex = index;
    this.drawOverlay();
    const ref = this.refs[index];
    this.flyTo(ref.lon, ref.lat);
    this.opts.onSelect(ref);
  }

  selectByIso2(iso2: string): boolean {
    const idx = this.refs.findIndex((r) => r.iso2 === iso2.toUpperCase());
    if (idx < 0) return false;
    this.select(idx);
    return true;
  }

  /**
   * 지정 좌표가 화면 정면(+Z)에 오도록 회전.
   * 회전각은 SphereGeometry UV 규약에서 유도했고, 보간은 프레임레이트와 무관하게
   * 경과시간 기준으로 처리한다(프레임이 느린 환경에서도 목표에 정확히 도달해야 한다).
   */
  flyTo(lon: number, lat: number): void {
    const psi = ((lon + 180) * Math.PI) / 180;
    const ry = Math.PI / 2 - psi;
    const rx = THREE.MathUtils.clamp((lat * Math.PI) / 180, -1.2, 1.2);
    // 현재 각도에서 가장 가까운 등가 각도로 이동(한 바퀴 돌지 않게)
    const current = this.group.rotation.y;
    const twoPi = Math.PI * 2;
    let target = ry;
    while (target - current > Math.PI) target -= twoPi;
    while (current - target > Math.PI) target += twoPi;
    this.flying = {
      fromX: this.group.rotation.x,
      fromY: current,
      toX: rx,
      toY: target,
      t: 0,
      dur: this.reducedMotion ? 0.05 : 0.85,
    };
    this.autoRotate = false;
  }

  isFlying(): boolean {
    return this.flying !== null;
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on;
  }

  isAutoRotating(): boolean {
    return this.autoRotate;
  }

  zoom(delta: number): void {
    this.targetZoom = THREE.MathUtils.clamp(this.targetZoom + delta, 2.2, 8.0);
  }

  private resize(): void {
    const host = this.canvas.parentElement;
    const w = host?.clientWidth || window.innerWidth;
    const h = host?.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private clock = new THREE.Clock();
  private frames = 0;

  /** 렌더가 실제로 일어나는지 확인하는 진단용(E2E 검증에서 사용) */
  renderStats(): { frames: number; calls: number; triangles: number } {
    const r = this.renderer.info.render;
    return { frames: this.frames, calls: r.calls, triangles: r.triangles };
  }

  private animate = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, this.clock.getDelta());

    if (this.flying) {
      const f = this.flying;
      f.t = Math.min(1, f.t + dt / f.dur);
      const k = 1 - Math.pow(1 - f.t, 3); // easeOutCubic
      this.group.rotation.x = f.fromX + (f.toX - f.fromX) * k;
      this.group.rotation.y = f.fromY + (f.toY - f.fromY) * k;
      if (f.t >= 1) this.flying = null;
    } else if (this.autoRotate && !this.dragging) {
      this.group.rotation.y += dt * 0.06;
    }

    this.camera.position.z += (this.targetZoom - this.camera.position.z) * 0.12;

    const pulse = 1 + Math.sin(this.clock.elapsedTime * 2.1) * 0.14;
    this.markerPulse.forEach((p, i) => {
      const mat = p.material as THREE.PointsMaterial;
      const base = i === 0 ? 0.045 : 0.055;
      mat.size = base * (this.reducedMotion ? 1 : pulse);
    });

    this.renderer.render(this.scene, this.camera);
    this.frames++;
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
  }
}
