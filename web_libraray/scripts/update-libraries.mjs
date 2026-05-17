import { writeFile } from "node:fs/promises";

const endpoint = "https://api.data.go.kr/openapi/tn_pubr_public_lbrry_api";
const outputPath = new URL("../libraries.json", import.meta.url);
const serviceKey = process.env.PUBLIC_LIBRARY_API_KEY;

if (!serviceKey) {
  console.error("PUBLIC_LIBRARY_API_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

const items = [];
const pageSize = 1000;
const maxPages = 30;

for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
  const url = new URL(endpoint);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("type", "json");
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(pageSize));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`도서관 API 요청 실패: ${response.status}`);
  }

  const payload = await response.json();
  const rawItems = asArray(payload.response?.body?.items || payload.items || payload.PublicLibraryInfo || []);
  items.push(...rawItems.map(normalizeLibrary).filter((library) => library.name && Number.isFinite(library.latitude) && Number.isFinite(library.longitude)));

  if (rawItems.length < pageSize) break;
}

const body = {
  generatedAt: new Date().toISOString(),
  source: endpoint,
  items: dedupeLibraries(items)
};

await writeFile(outputPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
console.log(`Saved ${body.items.length} libraries to ${outputPath.pathname}`);

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
