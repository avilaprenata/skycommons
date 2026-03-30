const EARTH_RADIUS_KM = 6378.137;
const ACTIVE_FEED_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json";

const elements = {
  search: document.getElementById("search"),
  yearFilter: document.getElementById("yearFilter"),
  limitFilter: document.getElementById("limitFilter"),
  refreshBtn: document.getElementById("refreshBtn"),
  visibleCount: document.getElementById("visibleCount"),
  sourceCount: document.getElementById("sourceCount"),
  loading: document.getElementById("loading"),
  error: document.getElementById("error"),
};

const state = {
  raw: [],
  filtered: [],
  entities: [],
  updateIntervalId: null,
};

const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  timeline: false,
  geocoder: false,
  baseLayerPicker: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  infoBox: false,
  selectionIndicator: false,
  shouldAnimate: true,
});

viewer.scene.globe.enableLighting = true;
viewer.clock.multiplier = 20;

function setLoading(isLoading) {
  elements.loading.classList.toggle("hidden", !isLoading);
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.classList.remove("hidden");
}

function clearError() {
  elements.error.textContent = "";
  elements.error.classList.add("hidden");
}

function typeColor(name = "") {
  const n = name.toUpperCase();

  if (n.includes("ISS") || n.includes("CSS") || n.includes("TIANGONG")) {
    return Cesium.Color.MEDIUMSPRINGGREEN;
  }
  if (n.includes(" DEB")) {
    return Cesium.Color.KHAKI;
  }
  if (n.includes(" R/B") || n.includes(" ROCKET")) {
    return Cesium.Color.HOTPINK;
  }

  return Cesium.Color.SKYBLUE;
}

function parseLaunchYear(intDes = "") {
  const match = String(intDes).match(/^(\d{4})-/);
  return match ? match[1] : "";
}

function meanMotionToSemiMajorAxisKm(meanMotionRevPerDay) {
  const mu = 398600.4418;
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86400;
  return Math.cbrt(mu / (n * n));
}

function isLEO(objectData) {
  const meanMotion = Number(objectData.MEAN_MOTION);
  const eccentricity = Number(objectData.ECCENTRICITY || 0);

  if (!meanMotion || Number.isNaN(meanMotion)) {
    return false;
  }

  const semiMajorAxisKm = meanMotionToSemiMajorAxisKm(meanMotion);
  const apogeeKm = semiMajorAxisKm * (1 + eccentricity) - EARTH_RADIUS_KM;

  return apogeeKm < 2000;
}

async function fetchSatellites() {
  const response = await fetch(ACTIVE_FEED_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch satellite data: ${response.status}`);
  }

  return response.json();
}

function populateYearFilter(items) {
  const years = [...new Set(items.map((item) => parseLaunchYear(item.INTLDES)).filter(Boolean))]
    .sort()
    .reverse();

  elements.yearFilter.innerHTML =
    '<option value="">All years</option>' +
    years.map((year) => `<option value="${year}">${year}</option>`).join("");
}

function clearEntities() {
  state.entities.forEach((entity) => viewer.entities.remove(entity));
  state.entities = [];
}

function buildOrbitSampledPath(satrec, now = new Date()) {
  const property = new Cesium.SampledPositionProperty();

  for (let minuteOffset = -45; minuteOffset <= 45; minuteOffset += 3) {
    const sampleTime = new Date(now.getTime() + minuteOffset * 60 * 1000);
    const positionVelocity = satellite.propagate(satrec, sampleTime);
    const gmst = satellite.gstime(sampleTime);

    if (!positionVelocity.position) {
      continue;
    }

    const geodetic = satellite.eciToGeodetic(positionVelocity.position, gmst);
    const cartesian = Cesium.Cartesian3.fromRadians(
      geodetic.longitude,
      geodetic.latitude,
      geodetic.height * 1000
    );

    property.addSample(Cesium.JulianDate.fromDate(sampleTime), cartesian);
  }

  return property;
}

function addSatelliteEntity(item, now) {
  const satrec = satellite.twoline2satrec(item.TLE_LINE1, item.TLE_LINE2);
  const positionVelocity = satellite.propagate(satrec, now);

  if (!positionVelocity.position) {
    return null;
  }

  const gmst = satellite.gstime(now);
  const geodetic = satellite.eciToGeodetic(positionVelocity.position, gmst);
  const position = Cesium.Cartesian3.fromRadians(
    geodetic.longitude,
    geodetic.latitude,
    geodetic.height * 1000
  );

  const color = typeColor(item.OBJECT_NAME);

  const entity = viewer.entities.add({
    id: String(item.NORAD_CAT_ID),
    name: item.OBJECT_NAME,
    position,
    point: {
      pixelSize: 4,
      color,
      outlineColor: Cesium.Color.WHITE.withAlpha(0.4),
      outlineWidth: 1,
    },
    label: {
      text: item.OBJECT_NAME,
      font: "11px sans-serif",
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.BLACK.withAlpha(0.45),
      pixelOffset: new Cesium.Cartesian2(10, -10),
      scale: 0.75,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3000000),
    },
    path: {
      material: color.withAlpha(0.45),
      width: 1,
      leadTime: 2700,
      trailTime: 2700,
      resolution: 60,
    },
  });

  entity.satrec = satrec;
  entity.orbitProperty = buildOrbitSampledPath(satrec, now);

  return entity;
}

function applyFilters() {
  const query = elements.search.value.trim().toUpperCase();
  const year = elements.yearFilter.value;
  const limit = Number(elements.limitFilter.value || 500);

  state.filtered = state.raw
    .filter(isLEO)
    .filter((item) => !query || String(item.OBJECT_NAME).toUpperCase().includes(query))
    .filter((item) => !year || parseLaunchYear(item.INTLDES) === year)
    .slice(0, limit);

  clearEntities();

  const now = new Date();

  state.entities = state.filtered
    .map((item) => addSatelliteEntity(item, now))
    .filter(Boolean);

  elements.sourceCount.textContent = state.raw.length.toLocaleString();
  elements.visibleCount.textContent = state.entities.length.toLocaleString();

  if (state.entities.length > 0) {
    viewer.flyTo(state.entities.slice(0, Math.min(50, state.entities.length)), {
      duration: 1.5,
    });
  }
}

function updatePositions() {
  const currentJulianDate = viewer.clock.currentTime;
  const currentDate = Cesium.JulianDate.toDate(currentJulianDate);

  for (const entity of state.entities) {
    const positionVelocity = satellite.propagate(entity.satrec, currentDate);
    const gmst = satellite.gstime(currentDate);

    if (!positionVelocity.position) {
      continue;
    }

    const geodetic = satellite.eciToGeodetic(positionVelocity.position, gmst);
    entity.position = Cesium.Cartesian3.fromRadians(
      geodetic.longitude,
      geodetic.latitude,
      geodetic.height * 1000
    );
  }
}

async function boot() {
  setLoading(true);
  clearError();

  try {
    state.raw = await fetchSatellites();
    populateYearFilter(state.raw.filter(isLEO));
    applyFilters();

    if (state.updateIntervalId) {
      clearInterval(state.updateIntervalId);
    }

    state.updateIntervalId = setInterval(updatePositions, 1000);
  } catch (error) {
    console.error(error);
    showError(
      "Unable to load satellite data. For production use, proxy and cache the feed on your own backend."
    );
  } finally {
    setLoading(false);
  }
}

elements.search.addEventListener("input", applyFilters);
elements.yearFilter.addEventListener("change", applyFilters);
elements.limitFilter.addEventListener("change", applyFilters);
elements.refreshBtn.addEventListener("click", boot);

boot();
