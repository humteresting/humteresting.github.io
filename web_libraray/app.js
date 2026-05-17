const CONFIG = {
  workerBaseUrl: "https://YOUR_WORKER_SUBDOMAIN.workers.dev",
  libraryCatalogUrl: "./libraries.json?v=20260517-2",
  libraryCacheTtlMs: 1000 * 60 * 60 * 24 * 7
};

const DB_NAME = "nearLibrary";
const DB_VERSION = 1;
const LIBRARY_STORE = "libraries";
const META_STORE = "meta";
const LIBRARY_CACHE_KEY = "libraryCatalogUpdatedAt";

const state = {
  books: [],
  selectedBook: null,
  libraries: [],
  position: null,
  favorites: new Set(JSON.parse(localStorage.getItem("favoriteLibraries") || "[]")),
  libraryCatalogPromise: null
};

const elements = {
  searchForm: document.querySelector("#searchForm"),
  query: document.querySelector("#query"),
  searchStatus: document.querySelector("#searchStatus"),
  bookResults: document.querySelector("#bookResults"),
  libraryResults: document.querySelector("#libraryResults"),
  selectedBookText: document.querySelector("#selectedBookText"),
  locationButton: document.querySelector("#locationButton"),
  locationSummary: document.querySelector("#locationSummary"),
  bookTemplate: document.querySelector("#bookTemplate"),
  libraryTemplate: document.querySelector("#libraryTemplate")
};

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = elements.query.value.trim();
  if (!query) return;
  await searchBooks(query);
});

elements.locationButton.addEventListener("click", async () => {
  const position = await ensurePosition(true);
  if (!position) return;

  enableSearch();
  if (state.selectedBook) {
    await loadLibrariesForSelectedBook();
  } else {
    await loadNearestLibraries();
  }
});

async function searchBooks(query) {
  if (!state.position) {
    setStatus("위치 설정을 먼저 완료해 주세요.", true);
    return;
  }

  setStatus("도서를 검색하고 있습니다.");
  setLoading(elements.searchForm.querySelector("button"), true);

  try {
    const data = await fetchJson(`/books?query=${encodeURIComponent(query)}`);
    state.books = data.items || [];
    state.selectedBook = null;
    renderBooks();
    elements.selectedBookText.textContent = "책을 선택하면 즐겨찾기 도서관을 먼저 반영합니다.";
    setStatus(state.books.length ? `${state.books.length}건의 도서를 찾았습니다.` : "검색 결과가 없습니다.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setLoading(elements.searchForm.querySelector("button"), false);
  }
}

async function selectBook(book, button) {
  state.selectedBook = book;
  document.querySelectorAll(".book-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  elements.selectedBookText.textContent = book.title;
  await loadLibrariesForSelectedBook();
}

async function loadNearestLibraries() {
  const position = await ensurePosition();
  if (!position) {
    renderLibraryEmpty("위치 권한을 허용하면 현재 위치 기준으로 정렬합니다.");
    return;
  }

  renderLibraryEmpty("가까운 도서관을 불러오고 있습니다.");

  try {
    const allLibraries = await getLibrariesWithDistance(position);
    state.libraries = prioritizeLibraries(allLibraries);
    elements.selectedBookText.textContent = "현재 위치 기준 가까운 도서관입니다.";
    renderLibraries("책을 검색하기 전에 가까운 도서관을 먼저 표시했습니다.");
  } catch (error) {
    renderLibraryEmpty(`위치는 설정되었습니다. 도서관 목록을 불러오는 중 문제가 발생했습니다: ${error.message}`);
  }
}

async function loadLibrariesForSelectedBook() {
  const position = await ensurePosition();
  if (!position) {
    renderLibraryEmpty("위치 권한을 허용하면 현재 위치 기준으로 정렬합니다.");
    return;
  }

  renderLibraryEmpty("즐겨찾기 도서관을 먼저 확인하고 있습니다.");

  try {
    const favoriteLibraries = await getFavoriteLibraries(position);
    if (favoriteLibraries.length) {
      state.libraries = favoriteLibraries;
      renderLibraries("즐겨찾기 도서관 우선 표시 중입니다. 전체 도서관 목록을 이어서 정렬합니다.");
    }

    const allLibraries = await getLibrariesWithDistance(position);
    state.libraries = prioritizeLibraries(allLibraries);
    elements.selectedBookText.textContent = `${state.selectedBook.title} 검색 후 가까운 도서관입니다.`;
    renderLibraries(
      favoriteLibraries.length
        ? "즐겨찾기 도서관을 먼저 보여준 뒤 전체 도서관을 거리순으로 정렬했습니다."
        : "전체 도서관을 거리순으로 정렬했습니다."
    );
  } catch (error) {
    renderLibraryEmpty(`위치는 설정되었습니다. 도서관 목록을 불러오는 중 문제가 발생했습니다: ${error.message}`);
  }
}

async function getFavoriteLibraries(position) {
  if (!state.favorites.size) return [];
  const catalog = await getLibraryCatalog({ allowStale: true });
  return prioritizeLibraries(
    catalog
      .filter((library) => state.favorites.has(library.id))
      .map((library) => addDistance(library, position))
      .filter((library) => Number.isFinite(library.distanceKm))
  );
}

async function getLibrariesWithDistance(position) {
  const catalog = await getLibraryCatalog();
  return catalog
    .map((library) => addDistance(library, position))
    .filter((library) => Number.isFinite(library.distanceKm));
}

function prioritizeLibraries(libraries) {
  return [...libraries].sort((a, b) => {
    const favoriteDelta = Number(state.favorites.has(b.id)) - Number(state.favorites.has(a.id));
    return favoriteDelta || a.distanceKm - b.distanceKm;
  });
}

async function getLibraryCatalog(options = {}) {
  if (!state.libraryCatalogPromise) {
    state.libraryCatalogPromise = loadLibraryCatalog(options).finally(() => {
      state.libraryCatalogPromise = null;
    });
  }
  return state.libraryCatalogPromise;
}

async function loadLibraryCatalog({ allowStale = false } = {}) {
  const db = await openDb();
  const [updatedAt, cachedLibraries] = await Promise.all([
    getMeta(db, LIBRARY_CACHE_KEY),
    getAllLibraries(db)
  ]);
  const isFresh = updatedAt && Date.now() - Number(updatedAt) < CONFIG.libraryCacheTtlMs;

  if (cachedLibraries.length && (isFresh || allowStale)) {
    if (!isFresh) refreshLibraryCatalog();
    return cachedLibraries;
  }

  const freshLibraries = await fetchLibraryCatalog();
  await replaceLibraries(db, freshLibraries);
  await setMeta(db, LIBRARY_CACHE_KEY, String(Date.now()));
  return freshLibraries;
}

async function refreshLibraryCatalog() {
  try {
    const db = await openDb();
    const freshLibraries = await fetchLibraryCatalog();
    await replaceLibraries(db, freshLibraries);
    await setMeta(db, LIBRARY_CACHE_KEY, String(Date.now()));
  } catch {
    // Background refresh should not interrupt the current interaction.
  }
}

async function fetchLibraryCatalog() {
  const response = await fetch(CONFIG.libraryCatalogUrl, { cache: "no-cache" });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error("정적 도서관 DB를 불러오지 못했습니다.");
  }

  const items = data.items || [];
  if (!items.length) {
    throw new Error("정적 도서관 DB가 비어 있습니다. libraries.json을 갱신해 주세요.");
  }
  return items;
}

function warmLibraryCatalog() {
  getLibraryCatalog({ allowStale: true }).catch(() => {
    setStatus("도서관 목록 캐시는 검색 후 다시 시도합니다.");
  });
}

async function ensurePosition(force = false) {
  if (state.position && !force) return state.position;
  if (!navigator.geolocation) {
    setStatus("이 브라우저는 위치 기능을 지원하지 않습니다.", true);
    elements.locationSummary.textContent = "현재 브라우저에서는 위치 설정을 사용할 수 없습니다.";
    return null;
  }

  elements.locationButton.disabled = true;
  elements.locationButton.textContent = "위치 확인 중";
  elements.locationSummary.textContent = "브라우저의 위치 권한 요청을 허용해 주세요.";
  setStatus("위치 설정 중입니다. Chrome 주소창 근처의 위치 권한 요청을 확인해 주세요.");

  try {
    const permission = await getLocationPermissionState();
    if (permission === "denied") {
      throw new Error("LOCATION_PERMISSION_DENIED");
    }

    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 300000
      });
    });
    state.position = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude
    };
    elements.locationButton.textContent = "위치 갱신";
    elements.locationSummary.textContent = `인지한 위치: 위도 ${state.position.latitude.toFixed(5)}, 경도 ${state.position.longitude.toFixed(5)}`;
    return state.position;
  } catch (error) {
    elements.locationButton.textContent = "위치 설정";
    showLocationError(error);
    return null;
  } finally {
    elements.locationButton.disabled = false;
  }
}

async function getLocationPermissionState() {
  if (!navigator.permissions?.query) return null;
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    return permission.state;
  } catch {
    return null;
  }
}

function showLocationError(error) {
  const code = error?.code;
  let message = "위치를 확인하지 못했습니다. Chrome 위치 권한과 Windows 위치 서비스를 확인해 주세요.";

  if (error?.message === "LOCATION_PERMISSION_DENIED" || code === 1) {
    message = "위치 권한이 차단되어 있습니다. 주소창 왼쪽 사이트 설정에서 위치 권한을 허용한 뒤 다시 눌러 주세요.";
  } else if (code === 2) {
    message = "현재 위치를 계산하지 못했습니다. Windows 위치 서비스나 네트워크 연결 상태를 확인해 주세요.";
  } else if (code === 3) {
    message = "위치 확인 시간이 초과되었습니다. 잠시 후 다시 누르거나 Chrome 위치 권한을 확인해 주세요.";
  }

  elements.locationSummary.textContent = message;
  setStatus(message, true);
}

function addDistance(library, position) {
  return {
    ...library,
    distanceKm: haversineKm(position.latitude, position.longitude, library.latitude, library.longitude)
  };
}

function enableSearch() {
  elements.query.disabled = false;
  const button = elements.searchForm.querySelector("button");
  button.disabled = false;
  setStatus("가까운 도서관을 확인했습니다. 이제 책을 검색할 수 있습니다.");
}

function renderBooks() {
  elements.bookResults.className = "book-list";
  elements.bookResults.replaceChildren();

  if (!state.books.length) {
    renderBookEmpty("검색 결과가 없습니다.");
    return;
  }

  state.books.forEach((book) => {
    const node = elements.bookTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".book-title").textContent = book.title || "제목 없음";
    node.querySelector(".book-meta").textContent =
      [book.author, book.publisher, book.pubYear].filter(Boolean).join(" · ") || "상세 정보 없음";
    node.querySelector(".book-isbn").textContent = book.isbn ? `ISBN ${book.isbn}` : "ISBN 정보 없음";
    node.addEventListener("click", () => selectBook(book, node));
    elements.bookResults.append(node);
  });
}

function renderLibraries(message = "") {
  elements.libraryResults.className = "library-list";
  elements.libraryResults.replaceChildren();

  if (!state.libraries.length) {
    renderLibraryEmpty("주변 도서관 정보를 찾지 못했습니다.");
    return;
  }

  if (message) {
    const note = document.createElement("p");
    note.className = "library-note";
    note.textContent = message;
    elements.libraryResults.append(note);
  }

  state.libraries.slice(0, 80).forEach((library) => {
    const node = elements.libraryTemplate.content.firstElementChild.cloneNode(true);
    const isFavorite = state.favorites.has(library.id);
    node.classList.toggle("favorite", isFavorite);
    node.querySelector("h3").textContent = library.name || "도서관명 없음";
    node.querySelector(".library-address").textContent = library.address || "주소 정보 없음";
    node.querySelector(".library-contact").textContent = library.tel ? `전화 ${library.tel}` : "전화 정보 없음";
    node.querySelector(".distance-badge").textContent = `${library.distanceKm.toFixed(1)} km`;

    const favoriteButton = node.querySelector(".favorite-button");
    favoriteButton.textContent = isFavorite ? "즐겨찾기됨" : "즐겨찾기";
    favoriteButton.setAttribute("aria-pressed", String(isFavorite));
    favoriteButton.addEventListener("click", () => toggleFavorite(library.id));

    elements.libraryResults.append(node);
  });
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) {
    state.favorites.delete(id);
  } else {
    state.favorites.add(id);
  }
  localStorage.setItem("favoriteLibraries", JSON.stringify([...state.favorites]));
  state.libraries = prioritizeLibraries(state.libraries);
  renderLibraries("즐겨찾기 순서를 반영했습니다.");
}

async function fetchJson(path) {
  const baseUrl = CONFIG.workerBaseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "요청 처리 중 오류가 발생했습니다.");
  }
  return data;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
        db.createObjectStore(LIBRARY_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllLibraries(db) {
  return transactionRequest(db, LIBRARY_STORE, "readonly", (store) => store.getAll());
}

function getMeta(db, key) {
  return transactionRequest(db, META_STORE, "readonly", (store) => store.get(key));
}

function setMeta(db, key, value) {
  return transactionRequest(db, META_STORE, "readwrite", (store) => store.put(value, key));
}

function replaceLibraries(db, libraries) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LIBRARY_STORE, "readwrite");
    const store = transaction.objectStore(LIBRARY_STORE);
    store.clear();
    libraries.forEach((library) => store.put(library));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function transactionRequest(db, storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

function renderBookEmpty(message) {
  elements.bookResults.className = "book-list empty-state";
  elements.bookResults.textContent = message;
}

function renderLibraryEmpty(message) {
  elements.libraryResults.className = "library-list empty-state";
  elements.libraryResults.textContent = message;
}

function setStatus(message, isError = false) {
  elements.searchStatus.textContent = message;
  elements.searchStatus.classList.toggle("error", isError);
}

function setLoading(button, isLoading) {
  button.disabled = isLoading;
  button.textContent = isLoading ? "검색 중" : "검색";
}
