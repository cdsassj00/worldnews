/**
 * 빌드 시 지도/국가 데이터를 생성한다.
 *  - public/data/countries-110m.json : world-atlas TopoJSON (지구본 텍스처 렌더용)
 *  - src/data/generated/countries.json : 숫자ID → { iso2, ko, en, lon, lat }
 *
 * 실행: npm run data
 */
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { feature } from "topojson-client";
import countries from "i18n-iso-countries";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

countries.registerLocale(JSON.parse(readFileSync(resolve(root, "node_modules/i18n-iso-countries/langs/ko.json"), "utf8")));
countries.registerLocale(JSON.parse(readFileSync(resolve(root, "node_modules/i18n-iso-countries/langs/en.json"), "utf8")));

const topoPath = resolve(root, "node_modules/world-atlas/countries-110m.json");
const outPublic = resolve(root, "public/data");
const outSrc = resolve(root, "src/data/generated");
mkdirSync(outPublic, { recursive: true });
mkdirSync(outSrc, { recursive: true });

copyFileSync(topoPath, resolve(outPublic, "countries-110m.json"));

const topo = JSON.parse(readFileSync(topoPath, "utf8"));
const geo = feature(topo, topo.objects.countries);

/** 가장 큰 링의 무게중심(면적 가중) — 마커 위치용 */
function centroid(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best = null;
  let bestArea = -1;
  for (const poly of polys) {
    const ring = poly[0];
    let area = 0;
    for (let i = 0, n = ring.length - 1; i < n; i++) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    area = Math.abs(area / 2);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  if (!best) return null;
  let x = 0;
  let y = 0;
  for (const [lon, lat] of best) {
    x += lon;
    y += lat;
  }
  return [x / best.length, y / best.length];
}

// world-atlas 이름 → ISO alpha-2 보정 (i18n-iso-countries 숫자코드가 비는 경우)
const NAME_FIX = {
  "Dem. Rep. Congo": "CD",
  "Central African Rep.": "CF",
  "S. Sudan": "SS",
  "W. Sahara": "EH",
  "Bosnia and Herz.": "BA",
  "Dominican Rep.": "DO",
  "Eq. Guinea": "GQ",
  "Solomon Is.": "SB",
  "Falkland Is.": "FK",
  "Fr. S. Antarctic Lands": "TF",
  "N. Cyprus": "CY",
  Somaliland: "SO",
  Kosovo: "XK",
  "Côte d'Ivoire": "CI",
  Czechia: "CZ",
  Myanmar: "MM",
  eSwatini: "SZ",
  Palestine: "PS",
  Greenland: "GL",
  "New Caledonia": "NC",
  Taiwan: "TW",
};

const out = {};
let missing = 0;
for (const f of geo.features) {
  const num = String(f.id).padStart(3, "0");
  const name = f.properties?.name ?? "";
  const iso2 = countries.numericToAlpha2(num) ?? NAME_FIX[name] ?? null;
  const c = centroid(f.geometry);
  if (!iso2) missing++;
  out[String(f.id)] = {
    iso2,
    en: name,
    ko: (iso2 && countries.getName(iso2, "ko")) || name,
    lon: c ? Number(c[0].toFixed(3)) : 0,
    lat: c ? Number(c[1].toFixed(3)) : 0,
  };
}

writeFileSync(resolve(outSrc, "countries.json"), JSON.stringify(out));
console.log(`✓ countries: ${Object.keys(out).length} (iso2 미매핑 ${missing}개)`);
console.log(`✓ public/data/countries-110m.json`);
