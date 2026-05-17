const LIBRARY_ENDPOINT = "https://api.data.go.kr/openapi/tn_pubr_public_lbrry_api";
const NL_SEARCH_ENDPOINT = "https://www.nl.go.kr/NL/search/openApi/search.do";
const LIBRARY_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/books") {
        return json(await searchBooks(url, env));
      }
      if (url.pathname === "/libraries/catalog") {
        return await cachedLibraryCatalog(request, env, ctx);
      }
      if (url.pathname === "/libraries") {
        return json(await searchLibraries(url, env));
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message || "Worker error" }, 500);
    }
  }
};

async function searchBooks(url, env) {
  const query = url.searchParams.get("query")?.trim();
  if (!query) throw new Error("검색어를 입력해 주세요.");
  if (!env.NL_API_KEY) throw new Error("NL_API_KEY 환경변수가 설정되지 않았습니다.");

  const apiUrl = new URL(NL_SEARCH_ENDPOINT);
  apiUrl.searchParams.set("key", env.NL_API_KEY);
  apiUrl.searchParams.set("kwd", query);
  apiUrl.searchParams.set("apiType", "json");
  apiUrl.searchParams.set("pageSize", "20");
  apiUrl.searchParams.set("pageNum", "1");

  const response = await fetch(apiUrl.toString());
  if (!response.ok) throw new Error("도서 검색 API 요청에 실패했습니다.");
  const payload = await response.json();
  const rawItems = payload.result || payload.docs || payload.items || [];

  return {
    items: asArray(rawItems).map(normalizeBook).filter((book) => book.title)
  };
}

async function cachedLibraryCatalog(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/libraries/catalog", request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached);

  const body = await getLibraryCatalog(env);
  const response = json(body, 200, {
    "cache-control": `public, max-age=${LIBRARY_CACHE_TTL_SECONDS}`
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function searchLibraries(url, env) {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("현재 위치 좌표가 필요합니다.");
  }

  const catalog = await getLibraryCatalog(env);
  return {
    items: catalog.items
      .map((library) => ({
        ...library,
        distanceKm: haversineKm(lat, lng, library.latitude, library.longitude)
      }))
      .filter((library) => Number.isFinite(library.distanceKm))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 50)
  };
}

async function getLibraryCatalog(env) {
  if (!env.PUBLIC_LIBRARY_API_KEY) {
    throw new Error("PUBLIC_LIBRARY_API_KEY 환경변수가 설정되지 않았습니다.");
  }

  const items = [];
  const pageSize = 1000;
  const maxPages = 20;

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const payload = await fetchLibraryPage(env.PUBLIC_LIBRARY_API_KEY, pageNo, pageSize);
    const rawItems = extractLibraryItems(payload);
    items.push(...rawItems.map(normalizeLibrary).filter((library) => library.name));

    if (rawItems.length < pageSize) break;
  }

  return { items: dedupeLibraries(items) };
}

async function fetchLibraryPage(serviceKey, pageNo, pageSize) {
  const apiUrl = new URL(LIBRARY_ENDPOINT);
  apiUrl.searchParams.set("serviceKey", serviceKey);
  apiUrl.searchParams.set("type", "json");
  apiUrl.searchParams.set("pageNo", String(pageNo));
  apiUrl.searchParams.set("numOfRows", String(pageSize));

  const response = await fetch(apiUrl.toString());
  if (!response.ok) throw new Error("도서관 API 요청에 실패했습니다.");
  return response.json();
}

function extractLibraryItems(payload) {
  return asArray(payload.response?.body?.items || payload.items || payload.PublicLibraryInfo || []);
}

function normalizeBook(item) {
  return {
    title: clean(item.title || item.bookname || item.bookName || item.text || item.TITLE),
    author: clean(item.author || item.authors || item.AUTHOR),
    publisher: clean(item.publisher || item.publer || item.PUBLISHER),
    pubYear: clean(item.pubYear || item.publication_year || item.YEAR),
    isbn: clean(item.isbn || item.isbn13 || item.EA_ISBN)
  };
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

function dedupeLibraries(items) {
  const map = new Map();
  items.forEach((item) => {
    if (!item.id || map.has(item.id)) return;
    map.set(item.id, item);
  });
  return [...map.values()];
}

function haversineKm(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Number.NaN;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
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

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...headers
    }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}
