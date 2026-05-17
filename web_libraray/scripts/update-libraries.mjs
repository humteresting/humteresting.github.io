import { writeFile } from "node:fs/promises";

const endpoint = "https://api.data.go.kr/openapi/tn_pubr_public_lbrry_api";
const outputPath = new URL("../libraries.json", import.meta.url);
const serviceKey = process.env.PUBLIC_LIBRARY_API_KEY;

if (!serviceKey) {
  console.error("PUBLIC_LIBRARY_API_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

const serviceKeyCandidates = [...new Set([serviceKey, decodeURIComponent(serviceKey)])];
const items = [];
const pageSize = 1000;
const maxPages = 30;
const maxRetries = 4;

for (const candidate of serviceKeyCandidates) {
  items.length = 0;
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const payload = await fetchLibraryPage(candidate, pageNo, pageSize);
    const rawItems = extractItems(payload);
    items.push(
      ...rawItems
        .map(normalizeLibrary)
        .filter((library) => library.name && Number.isFinite(library.latitude) && Number.isFinite(library.longitude))
    );

    if (rawItems.length < pageSize) break;
  }

  if (items.length) break;
}

if (!items.length) {
  throw new Error("도서관 API에서 유효한 도서관 데이터를 받지 못했습니다.");
}

const body = {
  generatedAt: new Date().toISOString(),
  source: endpoint,
  items: dedupeLibraries(items)
};

await writeFile(outputPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
console.log(`Saved ${body.items.length} libraries to ${outputPath.pathname}`);

async function fetchLibraryPage(key, pageNo, pageSize) {
  const url = new URL(endpoint);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("type", "json");
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(pageSize));

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`도서관 API 요청 실패: ${response.status} ${text.slice(0, 160)}`);
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`도서관 API가 JSON이 아닌 응답을 반환했습니다: ${text.slice(0, 160)}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await sleep(700 * attempt);
      }
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractItems(payload) {
  const body = payload.response?.body;
  return asArray(body?.items || payload.items || payload.PublicLibraryInfo || []);
}

function normalizeLibrary(item) {
  const lat = Number(item.latitude || item.lat || item.LATITUDE);
  const lng = Number(item.longitude || item.lng || item.LONGITUDE);
  const name = clean(item.lbrryNm || item.libraryName || item.name);
  const address = clean(item.rdnmadr || item.lnmadr || item.address);

  return {
    id: [name, address].filter(Boolean).join("|"),
    name,
    address,
    tel: clean(item.phoneNumber || item.tel || item.operInstitutionTelephoneNumber),
    latitude: lat,
    longitude: lng
  };
}

function dedupeLibraries(libraries) {
  const map = new Map();
  libraries.forEach((library) => {
    if (!library.id || map.has(library.id)) return;
    map.set(library.id, library);
  });
  return [...map.values()];
}

function clean(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.item)) return value.item;
  return [value];
}
