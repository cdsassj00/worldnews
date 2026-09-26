/**
 * TCP 소켓 기반 최소 HTTPS 클라이언트.
 *
 * 한국투자증권 OpenAPI는 9443(실전) / 29443(모의) 포트를 쓴다.
 * Cloudflare Workers 의 fetch() 는 환경에 따라 비표준 포트 서브리퀘스트가 막힐 수 있으므로
 * 그 경우 `cloudflare:sockets` 의 connect() 로 직접 TLS 연결해 HTTP/1.1 요청을 보낸다.
 *
 * 지원 범위는 이 프로젝트에 필요한 만큼이다: 단발 요청(connection: close),
 * content-length / chunked 응답 파싱, gzip 미사용(accept-encoding: identity).
 */
import { connect } from "cloudflare:sockets";

export interface SocketHttpRequest {
  host: string;
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface SocketHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const CRLF = "\r\n";

export async function socketHttpRequest(req: SocketHttpRequest): Promise<SocketHttpResponse> {
  const socket = connect({ hostname: req.host, port: req.port }, { secureTransport: "on", allowHalfOpen: false });
  const timeoutMs = req.timeoutMs ?? 10000;

  const encoder = new TextEncoder();
  const bodyBytes = req.body ? encoder.encode(req.body) : new Uint8Array(0);

  const headers: Record<string, string> = {
    host: req.port === 443 ? req.host : `${req.host}:${req.port}`,
    connection: "close",
    "accept-encoding": "identity",
    ...req.headers,
  };
  if (bodyBytes.length) headers["content-length"] = String(bodyBytes.length);

  let head = `${req.method.toUpperCase()} ${req.path} HTTP/1.1${CRLF}`;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}${CRLF}`;
  head += CRLF;

  const work = (async (): Promise<SocketHttpResponse> => {
    const writer = socket.writable.getWriter();
    try {
      await writer.write(encoder.encode(head));
      if (bodyBytes.length) await writer.write(bodyBytes);
    } finally {
      writer.releaseLock();
    }

    const reader = socket.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
          if (total > 4_000_000) break; // 방어적 상한
        }
      }
    } finally {
      reader.releaseLock();
    }

    const raw = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      raw.set(c, offset);
      offset += c.byteLength;
    }
    return parseResponse(raw);
  })();

  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`socket_timeout_${timeoutMs}ms`)), timeoutMs),
  );

  try {
    return await Promise.race([work, timer]);
  } finally {
    // close() 자체가 매달릴 수 있으므로 await 하지 않는다.
    void socket.close().catch(() => undefined);
  }
}

function indexOfDoubleCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

function parseResponse(raw: Uint8Array): SocketHttpResponse {
  const sep = indexOfDoubleCrlf(raw);
  if (sep < 0) throw new Error("malformed_http_response");
  const decoder = new TextDecoder();
  const headText = decoder.decode(raw.subarray(0, sep));
  const bodyBytes = raw.subarray(sep + 4);

  const lines = headText.split(/\r?\n/);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }

  let body: string;
  if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
    body = decodeChunked(bodyBytes);
  } else {
    const len = Number(headers["content-length"] ?? NaN);
    body = decoder.decode(Number.isFinite(len) ? bodyBytes.subarray(0, len) : bodyBytes);
  }
  return { status, headers, body };
}

function decodeChunked(buf: Uint8Array): string {
  const decoder = new TextDecoder();
  const parts: Uint8Array[] = [];
  let i = 0;
  while (i < buf.length) {
    // 청크 크기 라인 읽기
    let lineEnd = i;
    while (lineEnd + 1 < buf.length && !(buf[lineEnd] === 13 && buf[lineEnd + 1] === 10)) lineEnd++;
    const sizeText = decoder.decode(buf.subarray(i, lineEnd)).split(";")[0].trim();
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    parts.push(buf.subarray(start, start + size));
    i = start + size + 2; // 청크 뒤 CRLF
  }
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return decoder.decode(out);
}
